export function getCommitMessageTitle(message: string, fallback: string): string {
  const [firstLine = ''] = message.replace(/\r\n?/g, '\n').split('\n');
  return firstLine.trim() || fallback;
}
