import { writeFileSync } from 'fs';
import { kanji2number } from '@geolonia/japanese-numeral';

const lawId = process.argv[2];
const url = `https://laws.e-gov.go.jp/api/2/law_data/${lawId}?json_format=light&omit_amendment_suppl_provision=true`;

type AnyObj = Record<string, any>;

function cleanText(text: any): string {
  if (typeof text === 'string') return text.replace(/<Rt>.*?<\/Rt>/g, '').replace(/<\/?Ruby>/g, '');
  if (Array.isArray(text)) return text.map(cleanText).join('');
  if (text && typeof text === 'object') {
    if (text.Ruby) return cleanText(text.Ruby._text ?? text.Ruby._ ?? '');
    return cleanText(text._text ?? text._ ?? '');
  }
  return String(text ?? '');
}

function normalizeNumericTitle(title: string): string {
  return title.split('の').map(part => {
    if (!part.trim()) return '';
    try {
      const n = kanji2number(part);
      return Number.isNaN(n) ? part : String(n);
    } catch {
      return part;
    }
  }).join('の');
}

function extractSentenceText(obj: AnyObj | undefined): string {
  if (!obj) return '';
  const toText = (raw: any) => (Array.isArray(raw) ? raw : [raw]).map(cleanText).join(' ');
  if (obj['Sentence']) return toText(obj['Sentence']);
  if (obj['Column']) {
    const cols = Array.isArray(obj['Column']) ? obj['Column'] : [obj['Column']];
    return cols.map((col: any) => (col?.Sentence ? toText(col.Sentence) : '')).join('　');
  }
  return '';
}

function processItems(paragraph: AnyObj, pKey: string): AnyObj {
  const raw = paragraph['Item'];
  if (!raw) return {};
  const out: AnyObj = {};
  for (const item of (Array.isArray(raw) ? raw : [raw]) as AnyObj[]) {
    if (!item) continue;
    let itemNum = cleanText(item['ItemTitle']).replace(/^第/, '').replace(/号$/, '');
    if (itemNum) itemNum = normalizeNumericTitle(itemNum);
    const iKey = `${pKey}第${itemNum}号`;
    const itemText = extractSentenceText(item['ItemSentence'] as AnyObj);

    const subRaw = item['Subitem1'];
    const subitems: AnyObj = {};
    if (subRaw) {
      for (const sub of (Array.isArray(subRaw) ? subRaw : [subRaw]) as AnyObj[]) {
        if (!sub) continue;
        const subTitle = cleanText(sub['Subitem1Title']);
        subitems[`${iKey}${subTitle}`] = { 細分本文: extractSentenceText(sub['Subitem1Sentence'] as AnyObj) };
      }
    }

    out[iKey] = Object.keys(subitems).length > 0
      ? { 号柱書: itemText, ...subitems }
      : { 号本文: itemText };
  }
  return out;
}

function extractArticles(obj: unknown, lawTitle: string, out: AnyObj): void {
  if (Array.isArray(obj)) {
    obj.forEach(item => extractArticles(item, lawTitle, out));
  } else if (obj && typeof obj === 'object') {
    const node = obj as AnyObj;
    if (node['ArticleTitle'] && node['Paragraph']) {
      let articleTitle = cleanText(node['ArticleTitle']).replace(/^第/, '').replace(/条/, '');
      if (articleTitle) articleTitle = normalizeNumericTitle(articleTitle);
      let articleCaption = cleanText(node['ArticleCaption']).replace(/^（/, '').replace(/）$/, '');

      const articleKey = articleTitle.includes('の')
        ? '第' + articleTitle.replace('の', '条の')
        : '第' + articleTitle + '条';

      const paragraphs = Array.isArray(node['Paragraph']) ? node['Paragraph'] : [node['Paragraph']];
      const paragraphsOutput: AnyObj = {};

      for (const p of paragraphs as AnyObj[]) {
        if (!p) continue;
        const raw = ((p['ParagraphNum'] ?? p['Num'] ?? '') as string)
          .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
        const pNum = parseInt(raw, 10);
        const pKey = `${lawTitle}${articleKey}第${Number.isNaN(pNum) ? 1 : pNum}項`;
        const pText = extractSentenceText(p['ParagraphSentence'] as AnyObj);
        const items = processItems(p, pKey);

        paragraphsOutput[pKey] = Object.keys(items).length > 0
          ? { 項柱書: pText, ...items }
          : { 項本文: pText };
      }

      const [firstKey] = Object.keys(paragraphsOutput);
      const firstPara = paragraphsOutput[firstKey];
      const isDeleted =
        Object.keys(paragraphsOutput).length === 1 &&
        (firstPara?.項本文 === '削除' || firstPara?.項柱書 === '削除');
      if (isDeleted) return;

      if (!articleCaption && articleTitle === '3の2') articleCaption = '意思能力';

      const articleObj: AnyObj = { ...paragraphsOutput };
      if (articleCaption) articleObj.条見出し = articleCaption;
      out[articleKey] = articleObj;
    } else {
      for (const key in node) extractArticles(node[key], lawTitle, out);
    }
  }
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

const res = await fetch(url);
const json = await res.json() as AnyObj;
const law = json.law_full_text?.Law as AnyObj;
if (!law) process.exit(1);

const lawTitle =
  cleanText(law['LawTitle']) ||
  cleanText((law.LawBody as AnyObj)?.['LawTitle']) ||
  'output';

const articlesOutput: AnyObj = {};
const lawBody = law.LawBody as AnyObj;
if (lawBody?.MainProvision) extractArticles(lawBody.MainProvision, lawTitle, articlesOutput);

const sorted = sortArticles(articlesOutput);
const prefixed: AnyObj = {};
for (const key of Object.keys(sorted)) prefixed[`${lawTitle}${key}`] = sorted[key];

const sanitizedLawTitle = lawTitle.replace(/[\\/:*?"<>|]/g, '_');
writeFileSync(
  `${sanitizedLawTitle}.json`,
  JSON.stringify({ 法令名: lawTitle, ...prefixed }, null, 2),
);
