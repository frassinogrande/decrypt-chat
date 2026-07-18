// Strips the inline-markdown delimiters that MessageBubble renders (***both***,
// **bold**, *italic*, _italic_) so plain-text contexts like the chat-list preview
// show "hello" instead of the literal "**hello**".
//
// The alternation mirrors INLINE_MD_PATTERN in MessageBubble.svelte: markers must
// hug non-space content, so stray asterisks in ordinary prose (e.g. "$5 * 2") and
// unclosed markers (e.g. "**bold") are left untouched, matching what the renderer
// would actually consume. Keep in sync with that pattern.
export function stripInlineMarkdown(text: string): string {
    if (!text) return text;
    return text
        .replace(/\*\*\*(\S(?:[^*]*\S)?)\*\*\*/g, '$1')
        .replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, '$1')
        .replace(/\*(\S(?:[^*]*\S)?)\*/g, '$1')
        .replace(/_(\S(?:[^_]*\S)?)_/g, '$1');
}
