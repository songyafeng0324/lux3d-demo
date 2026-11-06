import { type CollectionRemoval, type PersonalRoom, type RoomPlacement, type RoomSaveReceipt } from '@aholo/contracts';
import { api, ApiError } from '../game/backpack-api.js';
export type RoomSaveStatus = 'loading' | 'loadFailed' | 'saved' | 'dirty' | 'saving' | 'failed' | 'rejected' | 'conflict';
export interface RoomSaveState { status: RoomSaveStatus; version: number; sequence: number; message: string }
export class PersonalRoomSave {
  current: PersonalRoom | null = null;
  state: RoomSaveState = { status: 'loading', version: 0, sequence: 0, message: '' };
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { key: string; sequence: number; body: { baseVersion: number; editSequence: number; name: string; placements: RoomPlacement[] } };
  private flight = false;
  private reading = false;
  private stopped = false;
  private loaded = false;
  private abort?: AbortController;
  private collectionVersions = new Map<number, number>();
  constructor(private csrf: () => string, private prepare: (room: PersonalRoom) => Promise<void>, private changed: (room: PersonalRoom | null, state: RoomSaveState) => void, private unauthorized: () => void) {}
  private emit(status: RoomSaveStatus, message = '') { if (this.stopped) return; this.state = { ...this.state, status, message }; this.changed(this.current, { ...this.state }); }
  async load() {
    if (this.flight || this.reading || this.stopped) return;
    clearTimeout(this.timer); this.reading = true; this.emit('loading');
    try {
      let room: PersonalRoom;
      do {
        room = await api<PersonalRoom>('/rooms/me', { cache: 'no-store' });
        if (room.sceneVersion !== 'courtyard-v1' || !Array.isArray(room.placements) || !Array.isArray(room.assets)) throw new Error('小屋数据格式无效。');
        if (this.stopped) return;
        if (!this.hasNewerCollectionVersion(room.version)) await this.prepare(room).catch(error => {
          if (!this.hasNewerCollectionVersion(room.version)) throw error;
        });
      } while (!this.stopped && this.hasNewerCollectionVersion(room.version));
      if (this.stopped) return;
      this.current = room; this.pending = undefined; this.loaded = true;
      this.state = { status: 'saved', version: room.version, sequence: 0, message: '' }; this.changed(this.current, { ...this.state });
      for (const version of this.collectionVersions.keys()) if (version < room.version) this.collectionVersions.delete(version);
    } catch (error) { this.emit('loadFailed', error instanceof ApiError && error.status === 401 ? '请先登录，再进入自己的小屋。' : error instanceof Error ? error.message : '无法读取已保存布置，读取成功前不会提交新布局。'); }
    finally { this.reading = false; }
  }
  edit(name: string, placements: RoomPlacement[]) {
    if (this.stopped || !this.canEdit || !this.current) return;
    this.current = { ...this.current, name, placements: structuredClone(placements) }; this.state.sequence++;
    if (this.state.status === 'conflict') { this.emit('conflict', '另一页面已更新房间，本页草稿保留。请显式载入已确认版本。'); return; }
    if (this.state.status === 'rejected') this.pending = undefined;
    const paused = this.state.status === 'failed';
    this.emit(paused ? 'failed' : this.flight ? 'saving' : 'dirty', paused ? '保存尚未确认，草稿保留；重试将确认原请求。' : '');
    clearTimeout(this.timer); if (!paused) this.timer = setTimeout(() => void this.flush(), 500);
  }
  async flush() {
    if (this.stopped || this.flight || !this.loaded || !this.current || ['loading', 'loadFailed', 'saved', 'conflict'].includes(this.state.status)) return;
    clearTimeout(this.timer);
    const csrf = this.csrf();
    if (!csrf) { this.emit('failed', '登录已失效，本页草稿保留，请重新登录后重试。'); return; }
    if (!this.pending) this.pending = { key: crypto.randomUUID(), sequence: this.state.sequence, body: { baseVersion: this.state.version, editSequence: this.state.sequence, name: this.current.name, placements: structuredClone(this.current.placements) } };
    const request = this.pending; this.flight = true; this.abort = new AbortController(); this.emit('saving');
    const timeout = setTimeout(() => this.abort?.abort(), 8000);
    try {
      const result = await api<RoomSaveReceipt>('/rooms/me/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.key, 'X-CSRF-Token': csrf }, body: JSON.stringify(request.body), signal: this.abort.signal });
      if (this.stopped) return;
      if (result.editSequence !== request.sequence || !Number.isSafeInteger(result.savedVersion) || result.savedVersion < this.state.version) throw new Error('保存回执无效。');
      this.state.version = result.savedVersion; this.current.version = result.savedVersion; this.pending = undefined;
      this.reconcileCollectionVersions();
      this.emit(this.state.sequence === request.sequence ? 'saved' : 'dirty');
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof ApiError && error.status === 409) this.emit('conflict', '房间已在别处保存或有模型被移除。本页草稿保留，载入已确认版本会放弃本页未保存修改。');
      else if (error instanceof ApiError && [400, 413, 422].includes(error.status)) {
        this.pending = undefined;
        this.emit(this.state.sequence > request.sequence ? 'dirty' : 'rejected', error.message);
      } else if (error instanceof ApiError && error.status === 401) {
        this.emit('failed', '登录已失效，本页草稿保留，请重新登录后重试。');
        this.unauthorized();
      } else this.emit('failed', '保存未获确认，本页修改保留；重试会确认同一次请求。');
    } finally {
      clearTimeout(timeout); this.flight = false;
      if (!this.stopped && this.state.status === 'dirty') this.timer = setTimeout(() => void this.flush(), 100);
      else if (!this.stopped && this.state.status === 'saved' && this.collectionVersions.size) void this.load();
    }
  }
  updateShare(enabled: boolean, shareUrl: string) { if (this.current) this.current = { ...this.current, shareEnabled: enabled, shareUrl }; this.changed(this.current, { ...this.state }); }
  private hasNewerCollectionVersion(version: number) {
    return [...this.collectionVersions.values()].some(next => next > version);
  }
  private reconcileCollectionVersions() {
    // Deletion may acknowledge a successor before the save that created its base version.
    // Advance only over confirmed consecutive removals, preserving any later draft edits.
    let next: number | undefined;
    while ((next = this.collectionVersions.get(this.state.version)) !== undefined) {
      this.collectionVersions.delete(this.state.version);
      this.state.version = next;
    }
    for (const version of this.collectionVersions.keys()) if (version < this.state.version) this.collectionVersions.delete(version);
    if (this.current) this.current.version = this.state.version;
  }
  removeCollectedAsset(assetId: string, removal: CollectionRemoval) {
    if (this.stopped || this.state.version > removal.roomVersion) return;
    if (removal.roomVersion > removal.previousVersion) this.collectionVersions.set(removal.previousVersion, removal.roomVersion);
    if (!this.current) return;
    const placements = this.current.placements.filter(placement => placement.assetId !== assetId);
    const assets = this.current.assets.filter(asset => asset.id !== assetId);
    if (removal.roomVersion === removal.previousVersion && this.pending?.body.placements.some(placement => placement.assetId === assetId)) this.state.sequence++;
    this.current = { ...this.current, version: this.state.version, placements, assets };
    if (!this.pending && !this.flight && !this.reading) this.reconcileCollectionVersions();
    this.changed(this.current, { ...this.state });
    if (this.state.status === 'saved' && this.state.version < removal.roomVersion) void this.load();
  }
  get canEdit() { return this.loaded && !['loading', 'loadFailed'].includes(this.state.status); }
  get unsaved() { return this.loaded && this.state.status !== 'saved'; }
  dispose() { this.stopped = true; clearTimeout(this.timer); this.abort?.abort(); }
}
