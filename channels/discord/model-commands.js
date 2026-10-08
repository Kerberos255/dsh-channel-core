/**
 * Pure helpers behind the Discord `/model` and `/think` commands. Kept apart from the transport so
 * the catalog projection can be unit tested without a Discord client.
 *
 * Host sources (all read per command, never cached):
 *   ctx.sessionController.modelCatalog()      -> { default, groups: [{ id, name, models: [...] }] }
 *   ctx.sessionController.projections({...})  -> { values: { modelSelection: { next, lastUsed } } }
 *   ctx.sessionController.selectModel({...})  -> { selected: { provider, model, reasoningEffort } }
 */

/** Discord caps autocomplete responses at 25 choices. */
export const CHOICE_LIMIT = 25;
/** Discord caps an autocomplete choice name and value at 100 characters. */
const TEXT_LIMIT = 100;

const clip = (text, limit = TEXT_LIMIT) => (text.length <= limit ? text : text.slice(0, limit - 1) + '…');

/** A model choice travels as `provider/model` so one autocomplete option carries both halves. */
export const encodeModel = (provider, model) => `${provider}/${model}`;

export function decodeModel(value) {
  const text = String(value ?? '').trim();
  const index = text.indexOf('/');
  if (index <= 0 || index === text.length - 1) return undefined;
  return { provider: text.slice(0, index), model: text.slice(index + 1) };
}

export function findModel(catalog, provider, model) {
  for (const group of catalog?.groups ?? []) {
    if (group.id !== provider) continue;
    for (const entry of group.models ?? []) if (entry.id === model) return { group, entry };
  }
  return undefined;
}

/** Autocomplete choices for `/model`: every routed model, optionally filtered by the typed query. */
export function modelChoices(catalog, query = '') {
  const needle = String(query ?? '').trim().toLowerCase();
  const choices = [];
  for (const group of catalog?.groups ?? []) {
    for (const entry of group.models ?? []) {
      const label = `${group.name} · ${entry.name}`;
      const haystack = `${label} ${group.id} ${entry.id}`.toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      choices.push({ name: clip(label), value: clip(encodeModel(group.id, entry.id)) });
      if (choices.length >= CHOICE_LIMIT) return choices;
    }
  }
  return choices;
}

/** Reasoning efforts the given model publishes; an empty list means the model has none. */
export function effortChoices(catalog, provider, model, query = '') {
  const found = findModel(catalog, provider, model);
  const efforts = found?.entry?.reasoning?.efforts ?? [];
  const needle = String(query ?? '').trim().toLowerCase();
  const choices = [];
  for (const effort of efforts) {
    const label = effort.description ? `${effort.name} — ${effort.description}` : effort.name;
    if (needle && !`${label} ${effort.id}`.toLowerCase().includes(needle)) continue;
    choices.push({ name: clip(label), value: clip(String(effort.id)) });
    if (choices.length >= CHOICE_LIMIT) break;
  }
  return choices;
}

/** The Session's own selection, from its `modelSelection` projection, falling back to the default. */
export function currentSelection(catalog, projections) {
  const value = projections?.values?.modelSelection;
  return value?.next ?? value?.lastUsed ?? catalog?.default ?? undefined;
}

/** The effort a `/model` switch should carry: the chosen model's published default, when it has one. */
export function defaultEffort(catalog, provider, model) {
  return findModel(catalog, provider, model)?.entry?.reasoning?.defaultEffort;
}

export function describeSelection(catalog, selection) {
  if (!selection?.provider || !selection?.model) return '未知模型';
  const entry = findModel(catalog, selection.provider, selection.model)?.entry;
  const effort = selection.reasoningEffort;
  const effortName = effort === undefined ? '默认' : entry?.reasoning?.efforts?.find(item => item.id === effort)?.name ?? effort;
  return `${selection.provider}/${selection.model}（推理强度：${effortName}）`;
}
