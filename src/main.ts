import * as fs from 'fs';
import * as https from 'https';
import { kanji2number } from '@geolonia/japanese-numeral';

const lawId = process.argv[2];

const url = `https://laws.e-gov.go.jp/api/2/law_data/${lawId}?json_format=light&omit_amendment_suppl_provision=true`;

https
  .get(url, res => {
    let data = '';
    res.on('data', chunk => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        const jsonOutput: Record<string, any> = {};
        function cleanText(text: any): string {
          if (typeof text !== 'string') {
            if (Array.isArray(text)) {
              return text.map(cleanText).join('');
            }
            if (typeof text === 'object' && text !== null) {
              if (text.Ruby) {
                return cleanText(text.Ruby._text || text.Ruby._ || '');
              }
              if (text._text) return cleanText(text._text);
              if (text._) return cleanText(text._);
              return '';
            }
            return String(text || '');
          }
          return text.replace(/<Rt>.*?<\/Rt>/g, '').replace(/<\/?Ruby>/g, '');
        }

        function extractArticles(obj: unknown) {
          if (Array.isArray(obj)) {
            obj.forEach(extractArticles);
          } else if (typeof obj === 'object' && obj !== null) {
            const node = obj as Record<string, unknown>;
            if (node['ArticleTitle'] && node['Paragraph']) {
              processArticle(node);
            } else {
              for (const key in node) {
                extractArticles(node[key]);
              }
            }
          }
        }

        function processArticle(article: Record<string, unknown>) {
          let articleTitle = cleanText(article['ArticleTitle']);

          articleTitle = articleTitle.replace(/^第/, '').replace(/条/, '');
          if (articleTitle) {
            articleTitle = articleTitle
              .split('の')
              .map(k => {
                if (!k.trim()) return '';
                try {
                  const num = kanji2number(k);
                  return Number.isNaN(num) ? k : num.toString();
                } catch {
                  return k;
                }
              })
              .join('の');
          }

          let articleCaption = cleanText(article['ArticleCaption']);
          articleCaption = articleCaption.replace(/^（/, '').replace(/）$/, '');

          const paragraphsOutput: Record<string, any> = {};

          function extractSentenceText(sentenceObj: Record<string, unknown> | undefined): string {
            if (!sentenceObj) return '';
            if (sentenceObj['Sentence']) {
              const rawSentences = sentenceObj['Sentence'];
              const sentences = Array.isArray(rawSentences) ? rawSentences : [rawSentences];
              return sentences.map(s => cleanText(s)).join(' ');
            } else if (sentenceObj['Column']) {
              const rawColumns = sentenceObj['Column'];
              const columns = Array.isArray(rawColumns) ? rawColumns : [rawColumns];
              const columnTexts = columns.map((col: any) => {
                if (col && col['Sentence']) {
                  const raw = col['Sentence'];
                  const s = Array.isArray(raw) ? raw : [raw];
                  return s.map(item => cleanText(item)).join(' ');
                }
                return '';
              });
              return columnTexts.join('　');
            }
            return '';
          }

          const rawParagraph = article['Paragraph'];
          const paragraphs = Array.isArray(rawParagraph)
            ? rawParagraph
            : [rawParagraph];

          paragraphs.forEach(pUnknown => {
            const p = pUnknown as Record<string, unknown>;
            if (!p) return;
            let pNumStr = (p['ParagraphNum'] || p['Num'] || '') as string;
            pNumStr = pNumStr.replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
            let pNum = parseInt(pNumStr, 10);
            if (Number.isNaN(pNum)) {
              pNum = 1;
            }

            const pSentence = p['ParagraphSentence'] as Record<string, unknown> | undefined;
            const pText = extractSentenceText(pSentence);

            const pObj: any = {
              項本文: pText,
            };

            if (p['Item']) {
              const itemsOutput: Record<string, any> = {};
              const rawItem = p['Item'];
              const items = Array.isArray(rawItem) ? rawItem : [rawItem];
              items.forEach(itemUnknown => {
                const item = itemUnknown as Record<string, unknown>;
                let itemTitle = cleanText(item['ItemTitle']);

                if (itemTitle) {
                  itemTitle = itemTitle.replace(/^第/, '').replace(/号$/, '');
                  itemTitle = itemTitle
                    .split('の')
                    .map(k => {
                      if (!k.trim()) return '';
                      try {
                        const num = kanji2number(k);
                        return Number.isNaN(num) ? k : num.toString();
                      } catch {
                        return k;
                      }
                    })
                    .join('の');
                }

                const itemSentence = item['ItemSentence'] as Record<string, unknown> | undefined;
                const itemText = extractSentenceText(itemSentence);

                const itemObj: any = {
                  号本文: itemText,
                };

                if (item['Subitem1']) {
                  const subitemsOutput: Record<string, any> = {};
                  const rawSubitem1 = item['Subitem1'];
                  const subitems1 = Array.isArray(rawSubitem1) ? rawSubitem1 : [rawSubitem1];
                  
                  subitems1.forEach(subUnknown => {
                    const sub = subUnknown as Record<string, unknown>;
                    if (!sub) return;
                    
                    let subTitle = cleanText(sub['Subitem1Title']);

                    const subSentence = sub['Subitem1Sentence'] as Record<string, unknown> | undefined;
                    const subText = extractSentenceText(subSentence);

                    subitemsOutput[subTitle] = {
                      細分本文: subText,
                    };
                  });
                  
                  if (Object.keys(subitemsOutput).length > 0) {
                    itemObj.細分 = subitemsOutput;
                    itemObj['号柱書'] = itemObj.号本文;
                    delete itemObj.号本文;
                  }
                }

                itemsOutput[itemTitle] = itemObj;
              });
              if (Object.keys(itemsOutput).length > 0) {
                pObj.号 = itemsOutput;
                pObj['項柱書'] = pObj.項本文;
                delete pObj.項本文;
              }
            }
            paragraphsOutput[pNum.toString()] = pObj;
          });

          const pKeys = Object.keys(paragraphsOutput);
          const isDeleted =
            pKeys.length === 1 &&
            (paragraphsOutput[pKeys[0]].項本文 === '削除' ||
              paragraphsOutput[pKeys[0]]['項柱書'] === '削除');

            if (!isDeleted) {
              const articleObj: any = {
                項: paragraphsOutput,
              };
              if (articleCaption) {
                articleObj.条見出し = articleCaption;
              } else if (articleTitle === '3の2') {
                articleObj.条見出し = '意思能力';
              }
              const searchKeyNumber = articleTitle.includes('の')
                ? articleTitle.replace('の', '条の')
                : articleTitle + '条';
              jsonOutput[searchKeyNumber] = articleObj;
            }
        }

        let lawTitle = 'output';
        const lawFullText = json.law_full_text as Record<string, unknown>;
        if (lawFullText?.Law) {
          const law = lawFullText.Law as Record<string, unknown>;

          const rawLawTitle = law['LawTitle'];
          if (rawLawTitle) {
            lawTitle = cleanText(rawLawTitle);
          }

          if (law.LawBody) {
            const lawBody = law.LawBody as Record<string, unknown>;
            if (!rawLawTitle && lawBody['LawTitle']) {
              const bTitle = lawBody['LawTitle'];
              lawTitle = Array.isArray(bTitle)
                ? bTitle.join('')
                : String(bTitle);
            }
            if (lawBody.MainProvision) {
              extractArticles(lawBody.MainProvision);
            }
          }
        }

        const originalLawTitle = lawTitle;
        const sanitizedLawTitle = lawTitle.replace(/[\\/:*?"<>|]/g, '_');

        const sortedArticles: Record<string, any> = {};
        Object.keys(jsonOutput)
          .sort((a, b) => {
            const aParts = a.split('の').map(Number);
            const bParts = b.split('の').map(Number);
            for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
              const aNum = aParts[i] || 0;
              const bNum = bParts[i] || 0;
              if (aNum !== bNum) return aNum - bNum;
            }
            return 0;
          })
          .forEach(key => {
            sortedArticles[key] = jsonOutput[key];
          });

        const finalOutput = {
          法令名: originalLawTitle,
          条: sortedArticles,
        };

        fs.writeFileSync(
          `${sanitizedLawTitle}.json`,
          JSON.stringify(finalOutput, null, 2),
        );
      } catch (e) {
        console.error(e);
      }
    });
  })
  .on('error', e => {
    console.error(e);
  });
