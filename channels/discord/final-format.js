import { splitDiscord } from 'dsh-channel-core/transport-utils';
import { convertMarkdownTables } from './tables.js';

const MAX_MESSAGE_CHARS=1900;

/** Discord native blockquote: prefix every physical line, including blanks.
 * This keeps paragraphs, lists and fenced-code contents inside the quote.
 */
export function quotePublicDraft(value){
  return String(value??'').replace(/\r\n?/g,'\n').split('\n').map(line=>'> '+line).join('\n');
}

/** Show already-committed Ask User context as native quoted draft history.
 * The final delivery will still strip this exact published prefix, so the
 * visible draft is never sent twice. Chunk before quoting to leave room for
 * quote markers on each physical line, including blank lines.
 */
export function formatAskUserDraft(value){
  const draft=String(value??'');
  if(!draft.trim())return [];
  return splitDiscord(draft,800).map(part=>quotePublicDraft(part));
}

/** Format only native committed interim messages. Never quote reasoning,
 * uncommitted stream text, tools, or duplicate Ask User context already sent.
 */
export function formatFinalWithQuotedDraft(text,{draftPrelude='',finalReplyText='',footnote=''}={}){
  const current=String(text??'');
  const ordinary=()=>{
    const chunks=splitDiscord(convertMarkdownTables(current),Math.max(600,MAX_MESSAGE_CHARS-footnote.length));
    chunks[chunks.length-1]+=footnote;
    return chunks;
  };
  // Exact native message segmentation is mandatory; partial/mismatched Ask
  // User prefixes must retain the original reply path rather than guessing.
  if(!draftPrelude||!finalReplyText||current!==draftPrelude+'\n\n'+finalReplyText)return ordinary();
  const draft=String(draftPrelude);
  const answer=convertMarkdownTables(finalReplyText);
  const quoted=quotePublicDraft(draft);
  const combined=quoted+'\n\n'+answer+footnote;
  if(combined.length<=MAX_MESSAGE_CHARS)return [combined];

  // Split before adding quote markers so code fences remain balanced, and
  // leave room for the > prefix on every line, even with many empty lines.
  const draftParts=splitDiscord(draft,800).map(part=>quotePublicDraft(part));
  const answerParts=splitDiscord(answer,Math.max(600,MAX_MESSAGE_CHARS-footnote.length));
  answerParts[answerParts.length-1]+=footnote;
  return [...draftParts,...answerParts];
}
