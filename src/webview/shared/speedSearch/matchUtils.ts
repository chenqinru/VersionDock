import type { MatchHighlightSegment } from './types';

/**
 * 将文本根据 query 进行切分，返回普通文本和高亮文本片段列表
 */
export function getMatchSegments(text: string, query?: string): MatchHighlightSegment[] {
  if (!text) return [];
  const trimmed = query?.trim();
  if (!trimmed) {
    return [{ text, isMatch: false }];
  }

  const segments: MatchHighlightSegment[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const queryLen = lowerQuery.length;

  let lastIndex = 0;
  let matchIndex = lowerText.indexOf(lowerQuery, lastIndex);

  while (matchIndex !== -1) {
    if (matchIndex > lastIndex) {
      segments.push({
        text: text.slice(lastIndex, matchIndex),
        isMatch: false,
      });
    }

    segments.push({
      text: text.slice(matchIndex, matchIndex + queryLen),
      isMatch: true,
    });

    lastIndex = matchIndex + queryLen;
    matchIndex = lowerText.indexOf(lowerQuery, lastIndex);
  }

  if (lastIndex < text.length) {
    segments.push({
      text: text.slice(lastIndex),
      isMatch: false,
    });
  }

  return segments.length > 0 ? segments : [{ text, isMatch: false }];
}

/**
 * 计算单个文件项与 query 的匹配情况
 */
export function matchSpeedSearchItem(
  filePath: string,
  fileNameOrQuery: string,
  maybeQuery?: string,
): { matched: boolean; score: number } {
  let fileName: string;
  let query: string;
  if (maybeQuery !== undefined) {
    fileName = fileNameOrQuery;
    query = maybeQuery;
  } else {
    query = fileNameOrQuery;
    fileName = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
  }

  const q = query.trim().toLowerCase();
  if (!q) return { matched: false, score: 0 };

  const normPath = filePath.toLowerCase().replace(/\\/g, '/');
  const normName = fileName.toLowerCase();

  const hasSlash = q.includes('/');

  if (!hasSlash) {
    // 优先检查文件名匹配
    const nameIndex = normName.indexOf(q);
    if (nameIndex !== -1) {
      // 文件名精确匹配、前缀匹配或子串匹配打分
      let score = 100;
      if (normName === q) score += 50;
      else if (nameIndex === 0) score += 30;
      else score += Math.max(0, 20 - nameIndex);
      return { matched: true, score };
    }

    // 其次检查全路径匹配
    const pathIndex = normPath.indexOf(q);
    if (pathIndex !== -1) {
      return { matched: true, score: 30 };
    }

    return { matched: false, score: 0 };
  }

  // query 包含斜杠，检查路径匹配
  const pathIndex = normPath.indexOf(q);
  if (pathIndex !== -1) {
    let score = 80;
    if (normPath.endsWith(q)) score += 20;
    return { matched: true, score };
  }

  return { matched: false, score: 0 };
}
