import * as fs from 'fs';
import * as https from 'https';
import { kanji2number } from '@geolonia/japanese-numeral';

const lawId = process.argv[2];
const url = `https://laws.e-gov.go.jp/api/2/law_data/${lawId}?json_format=light&omit_amendment_suppl_provision=true`;

type AnyObj = Record<string, any>;

function cleanText(text: any): string {
  if (typeof text === 'string') {
    return text.replace(/<Rt>.*?<\/Rt>/g, '').replace(/<\/?Ruby>/g, '');
  }
  if (Array.isArray(text)) return text.map(cleanText).join('');
  if (text && typeof text === 'object') {
    if (text.Ruby) return cleanText(text.Ruby._text ?? text.Ruby._ ?? '');
    if (text._text) return cleanText(text._text);
    if (text._) return cleanText(text._);
    return '';
  }
  return String(text ?? '');
}

function toNumber(k: string): string {
  if (!k.trim()) return '';
  try {
    const n = kanji2number(k);
    return Number.isNaN(n) ? k : String(n);
  } catch {
    return k;
  }
}

function normalizeNumericTitle(title: string): string {
  return title.split('の').map(toNumber).join('の');
}

function extractSentenceText(obj: AnyObj | undefined): string {
  if (!obj) return '';
  const toText = (raw: any) => {
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.map(cleanText).join(' ');
  };
  if (obj['Sentence']) return toText(obj['Sentence']);
  if (obj['Column']) {
    const cols = Array.isArray(obj['Column']) ? obj['Column'] : [obj['Column']];
    return cols.map((col: any) => (col?.Sentence ? toText(col.Sentence) : '')).join('　');
  }
  return '';
}

function processSubitems(item: AnyObj): AnyObj {
  const raw = item['Subitem1'];
  if (!raw) return {};
  const subitems = Array.isArray(raw) ? raw : [raw];
  const out: AnyObj = {};
  for (const sub of subitems as AnyObj[]) {
    if (!sub) continue;
    const title = cleanText(sub['Subitem1Title']);
    out[title] = { 細分本文: extractSentenceText(sub['Subitem1Sentence'] as AnyObj) };
  }
  return out;
}

function processItems(paragraph: AnyObj): AnyObj {
  const raw = paragraph['Item'];
  if (!raw) return {};
  const items = Array.isArray(raw) ? raw : [raw];
  const out: AnyObj = {};
  for (const item of items as AnyObj[]) {
    let title = cleanText(item['ItemTitle'])
      .replace(/^第/, '')
      .replace(/号$/, '');
    if (title) title = normalizeNumericTitle(title);

    const itemText = extractSentenceText(item['ItemSentence'] as AnyObj);
    const subitems = processSubitems(item);

    if (Object.keys(subitems).length > 0) {
      out[title] = { 号柱書: itemText, 細分: subitems };
    } else {
      out[title] = { 号本文: itemText };
    }
  }
  return out;
}

function parseParagraphNum(p: AnyObj): number {
  const raw = ((p['ParagraphNum'] ?? p['Num'] ?? '') as string)
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? 1 : n;
}

function buildArticleKey(articleTitle: string): string {
  return articleTitle.includes('の')
    ? articleTitle.replace('の', '条の')
    : articleTitle + '条';
}

const articlesOutput: AnyObj = {};

function extractArticles(obj: unknown): void {
  if (Array.isArray(obj)) {
    obj.forEach(extractArticles);
  } else if (obj && typeof obj === 'object') {
    const node = obj as AnyObj;
    if (node['ArticleTitle'] && node['Paragraph']) {
      processArticle(node);
    } else {
      for (const key in node) extractArticles(node[key]);
    }
  }
}

function processArticle(article: AnyObj): void {
  let articleTitle = cleanText(article['ArticleTitle'])
    .replace(/^第/, '')
    .replace(/条/, '');
  if (articleTitle) articleTitle = normalizeNumericTitle(articleTitle);

  let articleCaption = cleanText(article['ArticleCaption'])
    .replace(/^（/, '')
    .replace(/）$/, '');

  const rawParagraph = article['Paragraph'];
  const paragraphs = Array.isArray(rawParagraph) ? rawParagraph : [rawParagraph];
  const paragraphsOutput: AnyObj = {};

  for (const p of paragraphs as AnyObj[]) {
    if (!p) continue;
    const pNum = parseParagraphNum(p);
    const pText = extractSentenceText(p['ParagraphSentence'] as AnyObj);
    const items = processItems(p);

    if (Object.keys(items).length > 0) {
      paragraphsOutput[String(pNum)] = { 項柱書: pText, 号: items };
    } else {
      paragraphsOutput[String(pNum)] = { 項本文: pText };
    }
  }

  const [firstKey] = Object.keys(paragraphsOutput);
  const firstPara = paragraphsOutput[firstKey];
  const isDeleted =
    Object.keys(paragraphsOutput).length === 1 &&
    (firstPara?.項本文 === '削除' || firstPara?.項柱書 === '削除');
  if (isDeleted) return;

  if (!articleCaption && articleTitle === '3の2') {
    articleCaption = '意思能力';
  }

  const articleObj: AnyObj = { 項: paragraphsOutput };
  if (articleCaption) articleObj.条見出し = articleCaption;

  articlesOutput[buildArticleKey(articleTitle)] = articleObj;
}

function sortArticles(raw: AnyObj): AnyObj {
  const sorted: AnyObj = {};
  Object.keys(raw)
    .sort((a, b) => {
      const aParts = a.split('の').map(Number);
      const bParts = b.split('の').map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })
    .forEach(k => (sorted[k] = raw[k]));
  return sorted;
}

https
  .get(url, res => {
    let data = '';
    res.on('data', chunk => (data += chunk));
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        const lawFullText = json.law_full_text as AnyObj;
        const law = lawFullText?.Law as AnyObj;
        if (!law) return;

        let lawTitle =
          cleanText(law['LawTitle']) ||
          cleanText((law.LawBody as AnyObj)?.['LawTitle']) ||
          'output';

        const lawBody = law.LawBody as AnyObj;
        if (lawBody?.MainProvision) extractArticles(lawBody.MainProvision);

        const sanitizedLawTitle = lawTitle.replace(/[\\/:*?"<>|]/g, '_');
        fs.writeFileSync(
          `${sanitizedLawTitle}.json`,
          JSON.stringify({ 法令名: lawTitle, 条: sortArticles(articlesOutput) }, null, 2),
        );
      } catch (e) {
        console.error(e);
      }
    });
  })
  .on('error', e => console.error(e));
