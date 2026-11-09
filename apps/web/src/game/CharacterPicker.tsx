import { useCallback, useEffect, useState } from 'react';
import { CHARACTERS, loadPrefs, savePrefs, type AvatarPrefs, type CharacterId } from './avatar-prefs.js';
import shinChan from '../../../../assets/characters/runtime/thumbs/shin-chan.webp?url';
import humanoidTabby from '../../../../assets/characters/runtime/thumbs/humanoid-tabby.webp?url';
import maruko from '../../../../assets/characters/runtime/thumbs/maruko-tpose.webp?url';
import bull from '../../../../assets/characters/runtime/thumbs/bull-tpose.webp?url';
import whiteShirtBoy from '../../../../assets/characters/runtime/thumbs/white-shirt-boy.webp?url';
import pinkShortsGirl from '../../../../assets/characters/runtime/thumbs/pink-shorts-girl.webp?url';

/** Rendered from the runtime GLBs by scripts/render-character-thumbs.mjs. */
const THUMBS: Record<CharacterId, string> = {
  'shin-chan': shinChan, 'humanoid-tabby': humanoidTabby, 'maruko-tpose': maruko,
  'bull-tpose': bull, 'white-shirt-boy': whiteShirtBoy, 'pink-shorts-girl': pinkShortsGirl,
};

/** Per-browser avatar preference shared by the pavilion and the room (T15). */
export function useAvatarPrefs(): [AvatarPrefs, (next: AvatarPrefs) => void, () => void] {
  const [prefs, setPrefs] = useState<AvatarPrefs>(() => loadPrefs());
  const update = useCallback((next: AvatarPrefs) => { savePrefs(next); setPrefs(next); }, []);
  /** The engine fell back to first person after a failed load: show that, keep the saved choice for next time. */
  const fellBack = useCallback(() => setPrefs(p => ({ ...p, view: 'first' })), []);
  return [prefs, update, fellBack];
}

export const VIEW_LABEL = { third: '第三人称', first: '第一人称' } as const;
/** The one control hint shown by all three walkable scenes: pavilion, own-room visit and shared room. */
export const WALK_HINT = '点击画面锁定鼠标 · WASD 行走 · Shift 快走 · 空格跳跃 · V 切换视角 · C 选择角色 · Esc 释放鼠标';
/** Opens the character picker in every walkable scene. */
export const CHARACTER_KEY = 'KeyC';

/** Top-right entry, identical in all three scenes. */
export function CharacterButton({ onClick }: { onClick: () => void }) {
  return <button type="button" className="character-button" aria-keyshortcuts="C" aria-haspopup="dialog" onClick={onClick}>角色<kbd aria-hidden="true">C</kbd></button>;
}

/**
 * Thumbnail grid: one click applies the character (and the third-person view, so the change is visible)
 * and closes. Esc or C closes without changing; handled here in the capture phase so the page's own
 * shortcuts do not also act on the same key press. Tab cycles through the cards (modal focus trap).
 */
export default function CharacterPicker({ prefs, pick, close }: { prefs: AvatarPrefs; pick: (id: CharacterId) => void; close: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Tab') { // modal: keep Tab focus on the cards instead of the controls behind
        const cards = [...document.querySelectorAll<HTMLButtonElement>('.character-picker .character-card')];
        if (!cards.length) return;
        e.preventDefault();
        const at = cards.indexOf(document.activeElement as HTMLButtonElement);
        cards[at < 0 ? 0 : (at + (e.shiftKey ? cards.length - 1 : 1)) % cards.length].focus();
        return;
      }
      if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code !== 'Escape' && e.code !== CHARACTER_KEY) return;
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat) close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);
  return <div className="t10-modal-backdrop character-layer" onClick={close}>
    <section className="character-picker" role="dialog" aria-modal="true" aria-label="选择角色" onClick={e => e.stopPropagation()}>
      <div className="character-picker-head"><h2>选择角色</h2><small>点击即切换 · Esc 关闭</small></div>
      <div className="character-grid">
        {CHARACTERS.map(c => <button type="button" key={c.id} className="character-card" aria-pressed={prefs.character === c.id}
          autoFocus={prefs.character === c.id} onClick={() => pick(c.id)}>
          <img src={THUMBS[c.id]} alt="" width={256} height={256} draggable={false} />
          <span>{c.label}</span>
        </button>)}
      </div>
      <small className="character-picker-foot">当前 {VIEW_LABEL[prefs.view]} · 选角后以第三人称显示 · V 切换视角</small>
    </section>
  </div>;
}
