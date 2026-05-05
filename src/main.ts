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

function processSubitems(item: AnyObj, iKey: string): AnyObj {
  const raw = item['Subitem1'];
  if (!raw) return {};
  const subitems = Array.isArray(raw) ? raw : [raw];
  const out: AnyObj = {};
  for (const sub of subitems as AnyObj[]) {
    if (!sub) continue;
    const subTitle = cleanText(sub['Subitem1Title']);
    const sKey = `${iKey}${subTitle}`;
    out[sKey] = { 細分本文: extractSentenceText(sub['Subitem1Sentence'] as AnyObj) };
  }
  return out;
}

function processItems(paragraph: AnyObj, pKey: string): AnyObj {
  const raw = paragraph['Item'];
  if (!raw) return {};
  const items = Array.isArray(raw) ? raw : [raw];
  const out: AnyObj = {};
  for (const item of items as AnyObj[]) {
    let itemNum = cleanText(item['ItemTitle'])
      .replace(/^第/, '')
      .replace(/号$/, '');
    if (itemNum) itemNum = normalizeNumericTitle(itemNum);
    const iKey = `${pKey}第${itemNum}号`;

    const itemText = extractSentenceText(item['ItemSentence'] as AnyObj);
    const subitems = processSubitems(item, iKey);

    if (Object.keys(subitems).length > 0) {
      out[iKey] = { 号柱書: itemText, 細分: subitems };
    } else {
      out[iKey] = { 号本文: itemText };
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
    ? '第' + articleTitle.replace('の', '条の')
    : '第' + articleTitle + '条';
}

const articlesOutput: AnyObj = {};

function extractArticles(obj: unknown, lawTitle: string): void {
  if (Array.isArray(obj)) {
    obj.forEach(item => extractArticles(item, lawTitle));
  } else if (obj && typeof obj === 'object') {
    const node = obj as AnyObj;
    if (node['ArticleTitle'] && node['Paragraph']) {
      processArticle(node, lawTitle);
    } else {
      for (const key in node) extractArticles(node[key], lawTitle);
    }
  }
}

function processArticle(article: AnyObj, lawTitle: string): void {
  let articleTitle = cleanText(article['ArticleTitle'])
    .replace(/^第/, '')
    .replace(/条/, '');
  if (articleTitle) articleTitle = normalizeNumericTitle(articleTitle);

  let articleCaption = cleanText(article['ArticleCaption'])
    .replace(/^（/, '')
    .replace(/）$/, '');

  const articleKey = buildArticleKey(articleTitle);

  const rawParagraph = article['Paragraph'];
  const paragraphs = Array.isArray(rawParagraph) ? rawParagraph : [rawParagraph];
  const paragraphsOutput: AnyObj = {};

  for (const p of paragraphs as AnyObj[]) {
    if (!p) continue;
    const pNum = parseParagraphNum(p);
    const pText = extractSentenceText(p['ParagraphSentence'] as AnyObj);
    const pKey = `${lawTitle}${articleKey}第${pNum}項`;
    const items = processItems(p, pKey);

    if (Object.keys(items).length > 0) {
      paragraphsOutput[pKey] = { 項柱書: pText, 号: items };
    } else {
      paragraphsOutput[pKey] = { 項本文: pText };
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

  articlesOutput[articleKey] = articleObj;
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

function prefixLawTitle(articles: AnyObj, lawTitle: string): AnyObj {
  const out: AnyObj = {};
  for (const key of Object.keys(articles)) {
    out[`${lawTitle}${key}`] = articles[key];
  }
  return out;
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
        if (lawBody?.MainProvision) extractArticles(lawBody.MainProvision, lawTitle);

        const sanitizedLawTitle = lawTitle.replace(/[\\/:*?"<>|]/g, '_');
        fs.writeFileSync(
          `${sanitizedLawTitle}.json`,
          JSON.stringify({ 法令名: lawTitle, 条: prefixLawTitle(sortArticles(articlesOutput), lawTitle) }, null, 2),
        );
      } catch (e) {
        console.error(e);
      }
    });
  })
  .on('error', e => console.error(e));
