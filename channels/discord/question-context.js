/** Discord Ask User has already published a committed prefix as history.
 * A native Turn continues afterwards, so its final text still contains that
 * prefix. Remove only an exact delivered prefix, not partial/mismatching text.
 */
export function afterPresentedContext(value,context){
 const text=String(value??''),prefix=String(context??'');
 if(!prefix||!text.startsWith(prefix))return text;
 const rest=text.slice(prefix.length);
 // Native assistant/message commits are joined by paragraph breaks. Do not
 // treat same-line additions or rewrites as a provably delivered prefix.
 if(rest&&!/^\r?\n/.test(rest))return text;
 return rest.trimStart();
}
