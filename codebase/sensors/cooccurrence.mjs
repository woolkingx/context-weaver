// 即時共現層 (動態,query 時算,不存進 matrix)。
// token×AST 混合公式的 cooccur 因子。
//
// 以 doc 的內聚單元(行)為窗: 同窗出現的 token 視為共現一次。
// 對稱: cooccur(a,b) === cooccur(b,a)。

const COOCCUR_STOP = new Set(
  'the a an of to and or is are it its in on for as by be that this with only not no'.split(/\s+/),
);

export function cooccurTokens(text) {
  return (String(text).toLowerCase().match(/[a-z][a-z._-]{1,}/g) || [])
    .filter((token) => token.length >= 2 && !COOCCUR_STOP.has(token));
}

// 算 focus token 在多份 doc 文本內的共現分布。
// texts: string[] (每份 doc 的原文)
// 回 Map<otherToken, count>
export function cooccurrence(texts, focus) {
  const counts = new Map();
  const target = String(focus).toLowerCase();
  for (const text of texts) {
    for (const line of String(text).split(/\r?\n/)) {
      const tokens = new Set(cooccurTokens(line));
      if (!tokens.has(target)) continue;
      for (const token of tokens) {
        if (token === target) continue;
        counts.set(token, (counts.get(token) || 0) + 1);
      }
    }
  }
  return counts;
}

// 共現的「即時權重」貢獻: 1 + log1p(count)，多次共現遞減加成。
export function cooccurWeight(count) {
  return 1 + Math.log1p(Math.max(0, count));
}
