export type B2BTagConnection = { id: string; name: string; sent_at: string | null }

/** One destination gets a descriptive label; extra destinations are summarized as +N. */
export function b2bTagLabel(connections: B2BTagConnection[]): string {
  if (!connections.length) return ''
  if (connections.length === 1) return `Sent to B2BBricks ${connections[0].name}`
  return `B2BBricks +${connections.length - 1}`
}

/** Full destination list for the tag's hover/accessible text. */
export function b2bTagTitle(connections: B2BTagConnection[]): string {
  return connections.map(connection => `Sent to B2BBricks ${connection.name}`).join('\n')
}
