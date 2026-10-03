// WP-217: the agent chat's reply (↩), in the rooms' format: the first line of the quoted message, cut short, sent
// ahead of the user's own text so the agent knows which message it answers.
export const excerpt = (text: string, n = 200) => {
  const line = text.trim().split('\n').find((l) => l.trim()) ?? ''
  return line.length > n ? `${line.slice(0, n - 1)}…` : line
}
export const withReply = (reply: { name: string; text: string } | null, text: string) =>
  reply ? `replying to ${reply.name}: "${excerpt(reply.text)}"\n\n${text}` : text
