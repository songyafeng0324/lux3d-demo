/** T15 avatar preferences: per-browser only (no account or database field). Pure TS for node --test. */
export const CHARACTERS = [
  { id: 'humanoid-tabby', label: '拟人橘猫' },
  { id: 'white-shirt-boy', label: '白衣男孩' },
  { id: 'pink-shorts-girl', label: '粉裤女孩' },
  { id: 'bull-tpose', label: '黄衣牛角人' },
  { id: 'maruko-tpose', label: '红衣小丸子' },
  { id: 'shin-chan', label: '蜡笔小新' },
] as const;
export type CharacterId = typeof CHARACTERS[number]['id'];
export type ViewMode = 'third' | 'first';
export interface AvatarPrefs { character: CharacterId; view: ViewMode }

export const PREFS_KEY = 'aholo.avatar.v1';
export const DEFAULT_PREFS: AvatarPrefs = { character: 'humanoid-tabby', view: 'third' };

const isCharacter = (value: unknown): value is CharacterId => CHARACTERS.some(c => c.id === value);

/** Unknown or damaged values fall back field by field to the defaults. */
export function parsePrefs(raw: string | null | undefined): AvatarPrefs {
  let value: Partial<Record<keyof AvatarPrefs, unknown>> = {};
  try { const parsed = raw ? JSON.parse(raw) : null; if (parsed && typeof parsed === 'object') value = parsed; } catch { /* default */ }
  return {
    character: isCharacter(value.character) ? value.character : DEFAULT_PREFS.character,
    view: value.view === 'first' || value.view === 'third' ? value.view : DEFAULT_PREFS.view,
  };
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const browserStore = (): Store | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

/** Storage can be missing or throw (private window, blocked site data); the scene still works. */
export function loadPrefs(store: Store | undefined = browserStore()): AvatarPrefs {
  try { return parsePrefs(store?.getItem(PREFS_KEY)); } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(prefs: AvatarPrefs, store: Store | undefined = browserStore()): void {
  try { store?.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* keep in memory only */ }
}
export const characterLabel = (id: CharacterId) => CHARACTERS.find(c => c.id === id)!.label;
