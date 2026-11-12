import { relationalStore } from '@kit.ArkData';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';

const VAULT_HEADER_ID: string = '__insp_vault_header__';
const LEGACY_PURGE_MARKER_ID: string = '__insp_legacy_purge_pending__';
const INTERNAL_RECORD_PREFIX: string = '__insp_';
const MANAGED_ATTACHMENT_NAME: RegExp = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

export type NoteKind = 'richtext' | 'mindmap' | 'todo';

interface MindMapBranch {
  id: string;
  text: string;
  children: MindMapBranch[];
}

interface MindMapContent {
  type: 'mindmap';
  root: MindMapBranch;
}

interface RichTextParagraph {
  type: 'paragraph';
}

interface RichTextTaskAttrs {
  checked: boolean;
}

interface RichTextTaskItem {
  type: 'taskItem';
  attrs: RichTextTaskAttrs;
  content: RichTextParagraph[];
}

interface RichTextTaskList {
  type: 'taskList';
  content: RichTextTaskItem[];
}

interface RichTextContent {
  type: 'doc';
  content: (RichTextParagraph | RichTextTaskList)[];
}

interface ContentTypeMarker {
  type?: string;
}

interface ImageFormat {
  extension: string;
  mimeType: string;
}

export interface NoteGroup {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  groupId: string | null;
  kind: NoteKind;
  privacy: 'normal' | 'private';
  syncPolicy: 'localOnly' | 'sync';
  preview: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface Note {
  id: string;
  title: string;
  groupId: string | null;
  kind: NoteKind;
  privacy: 'normal' | 'private';
  syncPolicy: 'localOnly' | 'sync';
  preview: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  schemaVersion: number;
  content: Object;
}

export interface NoteWrite {
  id: string;
  title: string;
  groupId: string | null;
  content: Object;
  plainText: string;
}

export interface WorkspaceSnapshot {
  groups: NoteGroup[];
  notes: NoteSummary[];
  dataDirectory: string;
}

export interface Attachment {
  id: string;
  mimeType: string;
  originalName: string;
  byteLength: number;
}

export interface AttachmentContent {
  bytes: Uint8Array;
  mimeType: string;
}

export interface VaultRecord {
  id: string;
  payload: string | null;
}

export interface VaultPut {
  id: string;
  payload: string;
}

export interface VaultCommitInput {
  header?: string;
  puts: VaultPut[];
  deletes: string[];
  purgeLegacy?: boolean;
}

export interface LegacyNote extends Note {
  deletedAt: string | null;
}

export interface LegacyAttachment extends Attachment {
  dataBase64: string;
}

export interface LegacyExport {
  groups: NoteGroup[];
  notes: LegacyNote[];
  attachments: LegacyAttachment[];
  dataDirectory: string;
}

interface LegacyAttachmentRow {
  attachment: Attachment;
  fileName: string;
}

export class NotesRepository {
  private readonly store: relationalStore.RdbStore;
  private readonly attachmentsDirectory: string;
  private readonly dataDirectory: string;
  private readonly base64: util.Base64Helper = new util.Base64Helper();
  private vaultActive: boolean = false;

  private constructor(store: relationalStore.RdbStore, context: common.UIAbilityContext) {
    this.store = store;
    this.dataDirectory = context.filesDir;
    this.attachmentsDirectory = context.filesDir + '/attachments';
    if (!fileIo.accessSync(this.attachmentsDirectory)) {
      fileIo.mkdirSync(this.attachmentsDirectory);
    }
  }

  static async open(context: common.UIAbilityContext): Promise<NotesRepository> {
    const store = await relationalStore.getRdbStore(context, {
      name: 'notes.sqlite3',
      securityLevel: relationalStore.SecurityLevel.S1,
      encrypt: false
    });
    const repository = new NotesRepository(store, context);
    await repository.initialize();
    return repository;
  }

  private async initialize(): Promise<void> {
    const versions = await this.queryRows(
      'PRAGMA user_version',
      [],
      (result: relationalStore.ResultSet): number => result.getLong(0)
    );
    const version = versions[0];
    if (version > 1) {
      throw new Error('数据库版本 ' + version + ' 高于此版本应用支持的版本，请升级应用。');
    }
    await this.store.executeSql('PRAGMA foreign_keys = ON');
    await this.store.executeSql('CREATE TABLE IF NOT EXISTS secureRecords (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)');
    await this.store.executeSql('CREATE TABLE IF NOT EXISTS vaultState (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
    await this.store.executeSql('CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES groups(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    await this.store.executeSql("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, group_id TEXT REFERENCES groups(id) ON DELETE SET NULL, kind TEXT NOT NULL DEFAULT 'richtext', privacy TEXT NOT NULL DEFAULT 'normal', sync_policy TEXT NOT NULL DEFAULT 'localOnly', schema_version INTEGER NOT NULL DEFAULT 1, content TEXT NOT NULL, plain_text TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1, server_revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)");
    await this.store.executeSql('CREATE INDEX IF NOT EXISTS notes_updated ON notes(updated_at DESC)');
    await this.store.executeSql('CREATE INDEX IF NOT EXISTS notes_group ON notes(group_id)');
    await this.store.executeSql('CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, file_name TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, original_name TEXT NOT NULL, byte_length INTEGER NOT NULL, created_at TEXT NOT NULL)');
    await this.store.executeSql('CREATE TABLE IF NOT EXISTS sync_outbox (operation_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, entity_type TEXT NOT NULL, base_revision INTEGER NOT NULL, operation TEXT NOT NULL, cipher_envelope TEXT, created_at TEXT NOT NULL)');
    await this.store.executeSql('CREATE TABLE IF NOT EXISTS sync_state (account_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0)');
    if (version === 0) {
      await this.store.executeSql('PRAGMA user_version = 1');
    }
    this.vaultActive = (await this.vaultHeader()) !== null;
    const pendingPurge = await this.queryRows(
      'SELECT value FROM vaultState WHERE id = ?',
      [LEGACY_PURGE_MARKER_ID],
      (result: relationalStore.ResultSet): string => result.getString(0)
    );
    if (pendingPurge.length > 0 && this.vaultActive) {
      await this.purgeLegacyData();
    }
  }

  private async queryRows<T>(sql: string, args: Array<relationalStore.ValueType>, readRow: (result: relationalStore.ResultSet) => T): Promise<T[]> {
    const result = await this.store.querySql(sql, args);
    const rows: T[] = [];
    try {
      while (result.goToNextRow()) {
        rows.push(readRow(result));
      }
    } finally {
      result.close();
    }
    return rows;
  }

  private readGroup(result: relationalStore.ResultSet): NoteGroup {
    return {
      id: result.getString(0),
      name: result.getString(1),
      parentId: result.isColumnNull(2) ? null : result.getString(2),
      createdAt: result.getString(3),
      updatedAt: result.getString(4)
    };
  }

  private readSummary(result: relationalStore.ResultSet): NoteSummary {
    return {
      id: result.getString(0),
      title: result.getString(1),
      groupId: result.isColumnNull(2) ? null : result.getString(2),
      kind: result.getString(3) as NoteKind,
      privacy: result.getString(4) as 'normal' | 'private',
      syncPolicy: result.getString(5) as 'localOnly' | 'sync',
      preview: result.getString(6),
      createdAt: result.getString(7),
      updatedAt: result.getString(8),
      revision: result.getLong(9)
    };
  }

  private async readNote(id: string): Promise<Note> {
    const rows = await this.queryRows(
      'SELECT id, title, group_id, kind, privacy, sync_policy, preview, created_at, updated_at, revision, schema_version, content FROM notes WHERE id = ? AND deleted_at IS NULL',
      [id],
      (result: relationalStore.ResultSet): Note => {
        const summary = this.readSummary(result);
        return {
          id: summary.id,
          title: summary.title,
          groupId: summary.groupId,
          kind: summary.kind,
          privacy: summary.privacy,
          syncPolicy: summary.syncPolicy,
          preview: summary.preview,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          revision: summary.revision,
          schemaVersion: result.getLong(10),
          content: JSON.parse(result.getString(11)) as Object
        };
      }
    );
    if (rows.length === 0) {
      throw new Error('笔记不存在或已删除。');
    }
    return rows[0];
  }

  async loadWorkspace(): Promise<WorkspaceSnapshot> {
    await this.ensureLegacyReadable();
    const groups = await this.queryRows(
      'SELECT id, name, parent_id, created_at, updated_at FROM groups ORDER BY created_at, id',
      [],
      (result: relationalStore.ResultSet): NoteGroup => this.readGroup(result)
    );
    const notes = await this.queryRows(
      'SELECT id, title, group_id, kind, privacy, sync_policy, preview, created_at, updated_at, revision FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC, id',
      [],
      (result: relationalStore.ResultSet): NoteSummary => this.readSummary(result)
    );
    return { groups, notes, dataDirectory: this.dataDirectory };
  }

  getNote(id: string): Promise<Note> {
    if (this.vaultActive) {
      throw new Error('加密仓库已启用，请通过密文仓库读取笔记。');
    }
    return this.readNote(id);
  }

  async createNote(groupId: string | null, kind: NoteKind = 'richtext'): Promise<Note> {
    await this.ensureLegacyWritable();
    const id = util.generateRandomUUID();
    const timestamp = new Date().toISOString();
    const title = kind === 'mindmap' ? '未命名的灵感笔记' : kind === 'todo' ? '待办清单' : '未命名笔记';
    let contentJson: string;
    if (kind === 'mindmap') {
      const children: MindMapBranch[] = [];
      const root: MindMapBranch = { id: util.generateRandomUUID(), text: title, children };
      const content: MindMapContent = { type: 'mindmap', root };
      contentJson = JSON.stringify(content);
    } else {
      const paragraph: RichTextParagraph = { type: 'paragraph' };
      const taskAttrs: RichTextTaskAttrs = { checked: false };
      const taskItem: RichTextTaskItem = { type: 'taskItem', attrs: taskAttrs, content: [paragraph] };
      const taskList: RichTextTaskList = { type: 'taskList', content: [taskItem] };
      const content: RichTextContent = kind === 'todo'
        ? { type: 'doc', content: [taskList] }
        : { type: 'doc', content: [paragraph] };
      contentJson = JSON.stringify(content);
    }
    await this.store.executeSql(
      'INSERT INTO notes (id, title, group_id, kind, privacy, sync_policy, schema_version, content, plain_text, preview, revision, server_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, title, groupId, kind, 'normal', 'localOnly', 1, contentJson, '', '', 1, 0, timestamp, timestamp]
    );
    return this.readNote(id);
  }

  async saveNote(input: NoteWrite): Promise<Note> {
    await this.ensureLegacyWritable();
    let title = input.title.trim() || '未命名笔记';
    const preview = input.plainText.replace(/\s+/g, ' ').slice(0, 180);
    const contentType = (input.content as ContentTypeMarker).type;
    const previous = await this.getNote(input.id);
    const kind: NoteKind = contentType === 'mindmap' ? 'mindmap' : previous.kind === 'todo' ? 'todo' : 'richtext';
    if (kind === 'mindmap') {
      const map = input.content as MindMapContent;
      title = map.root.text.trim() ? map.root.text : '未命名的灵感笔记';
      map.root.text = title;
    }
    const contentJson = JSON.stringify(input.content);
    await this.store.executeSql(
      'UPDATE notes SET title = ?, group_id = ?, kind = ?, content = ?, plain_text = ?, preview = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL',
      [title, input.groupId, kind, contentJson, input.plainText, preview, new Date().toISOString(), input.id]
    );
    return this.readNote(input.id);
  }

  async deleteNote(id: string): Promise<void> {
    await this.ensureLegacyWritable();
    const timestamp = new Date().toISOString();
    await this.store.executeSql(
      'UPDATE notes SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL',
      [timestamp, timestamp, id]
    );
  }

  async createGroup(name: string): Promise<NoteGroup> {
    await this.ensureLegacyWritable();
    const id = util.generateRandomUUID();
    const timestamp = new Date().toISOString();
    await this.store.executeSql(
      'INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [id, name.trim(), timestamp, timestamp]
    );
    return this.readGroupById(id);
  }

  async renameGroup(id: string, name: string): Promise<NoteGroup> {
    await this.ensureLegacyWritable();
    await this.store.executeSql(
      'UPDATE groups SET name = ?, updated_at = ? WHERE id = ?',
      [name.trim(), new Date().toISOString(), id]
    );
    return this.readGroupById(id);
  }

  async deleteGroup(id: string): Promise<void> {
    await this.ensureLegacyWritable();
    this.store.beginTransaction();
    try {
      await this.store.executeSql('UPDATE notes SET group_id = NULL, updated_at = ?, revision = revision + 1 WHERE group_id = ?', [new Date().toISOString(), id]);
      await this.store.executeSql('DELETE FROM groups WHERE id = ?', [id]);
      this.store.commit();
    } catch (error) {
      this.store.rollBack();
      throw error as Error;
    }
  }

  private async readGroupById(id: string): Promise<NoteGroup> {
    const rows = await this.queryRows(
      'SELECT id, name, parent_id, created_at, updated_at FROM groups WHERE id = ?',
      [id],
      (result: relationalStore.ResultSet): NoteGroup => this.readGroup(result)
    );
    if (rows.length === 0) {
      throw new Error('分组不存在。');
    }
    return rows[0];
  }

  async importImage(originalName: string, bytes: number[]): Promise<Attachment> {
    await this.ensureLegacyWritable();
    if (bytes.length > 20 * 1024 * 1024) {
      throw new Error('图片不能超过 20 MB。');
    }
    const data = new Uint8Array(bytes);
    const image = this.detectImage(data);
    const id = util.generateRandomUUID();
    const fileName = id + '.' + image.extension;
    const path = this.attachmentsDirectory + '/' + fileName;
    const file = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.READ_WRITE);
    try {
      fileIo.writeSync(file.fd, data.buffer as ArrayBuffer);
    } finally {
      fileIo.closeSync(file.fd);
    }
    const attachment: Attachment = {
      id,
      mimeType: image.mimeType,
      originalName,
      byteLength: bytes.length
    };
    await this.store.executeSql(
      'INSERT INTO attachments (id, file_name, mime_type, original_name, byte_length, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, fileName, image.mimeType, originalName, bytes.length, new Date().toISOString()]
    );
    return attachment;
  }

  private detectImage(bytes: Uint8Array): ImageFormat {
    if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
      return { extension: 'png', mimeType: 'image/png' };
    }
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
      return { extension: 'jpg', mimeType: 'image/jpeg' };
    }
    if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56) {
      return { extension: 'gif', mimeType: 'image/gif' };
    }
    if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) {
      return { extension: 'webp', mimeType: 'image/webp' };
    }
    throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片。');
  }

  async resolveImage(id: string): Promise<string> {
    await this.ensureLegacyReadable();
    const rows = await this.queryRows(
      'SELECT file_name FROM attachments WHERE id = ?',
      [id],
      (result: relationalStore.ResultSet): string => result.getString(0)
    );
    if (rows.length === 0) {
      throw new Error('图片附件不存在。');
    }
    return '/attachments/' + rows[0];
  }

  readAttachment(fileName: string): AttachmentContent {
    if (this.vaultActive) {
      throw new Error('加密仓库已启用，不能读取旧明文附件。');
    }
    const match = /^([0-9a-f-]{36})\.(png|jpg|gif|webp)$/.exec(fileName);
    if (match === null) {
      throw new Error('图片地址无效。');
    }
    const path = this.attachmentsDirectory + '/' + fileName;
    const size = fileIo.statSync(path).size;
    const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
    const buffer = new ArrayBuffer(size);
    let readLength = 0;
    try {
      readLength = fileIo.readSync(file.fd, buffer, { length: size });
    } finally {
      fileIo.closeSync(file.fd);
    }
    const bytes = new Uint8Array(buffer.slice(0, readLength));
    const mimeType = match[2] === 'jpg' ? 'image/jpeg' : 'image/' + match[2];
    return { bytes, mimeType };
  }

  async vaultHeader(): Promise<string | null> {
    const rows = await this.queryRows(
      'SELECT payload FROM secureRecords WHERE id = ?',
      [VAULT_HEADER_ID],
      (result: relationalStore.ResultSet): string => result.getString(0)
    );
    return rows.length === 0 ? null : rows[0];
  }

  async vaultList(): Promise<VaultRecord[]> {
    const rows = await this.queryRows(
      "SELECT id, CASE WHEN substr(id, 1, 11) = 'attachment:' OR length(payload) > 524288 THEN NULL ELSE payload END FROM secureRecords WHERE id <> ? AND id <> ? ORDER BY id",
      [VAULT_HEADER_ID, LEGACY_PURGE_MARKER_ID],
      (result: relationalStore.ResultSet): VaultRecord => ({
        id: result.getString(0),
        payload: result.isColumnNull(1) ? null : result.getString(1)
      })
    );
    for (const record of rows) {
      if (record.payload === null && !record.id.startsWith('attachment:')) {
        const payload = await this.vaultGet(record.id);
        if (payload === null) {
          throw new Error('加密记录在列表读取期间丢失。');
        }
        record.payload = payload;
      }
    }
    return rows;
  }

  async vaultGet(id: string): Promise<string | null> {
    if (id.startsWith(INTERNAL_RECORD_PREFIX)) {
      return null;
    }
    const lengths = await this.queryRows(
      'SELECT length(payload) FROM secureRecords WHERE id = ?',
      [id],
      (result: relationalStore.ResultSet): number => result.getLong(0)
    );
    if (lengths.length === 0) {
      return null;
    }
    const length = lengths[0];
    const chunkSize = 512 * 1024;
    const chunks: string[] = [];
    for (let start = 1; start <= length; start += chunkSize) {
      const chunkRows = await this.queryRows(
        'SELECT substr(payload, ?, ?) FROM secureRecords WHERE id = ?',
        [start, Math.min(chunkSize, length - start + 1), id],
        (result: relationalStore.ResultSet): string => result.getString(0)
      );
      if (chunkRows.length !== 1) {
        throw new Error('加密记录在分块读取期间发生变化。');
      }
      chunks.push(chunkRows[0]);
    }
    return chunks.join('');
  }

  async vaultCommit(input: VaultCommitInput): Promise<void> {
    if (input.purgeLegacy === true && input.header === undefined && (await this.vaultHeader()) === null) {
      throw new Error('不能在加密仓库提交前清除旧数据。');
    }
    this.store.beginTransaction();
    try {
      if (input.header !== undefined) {
        await this.store.executeSql(
          'INSERT OR REPLACE INTO secureRecords (id, payload) VALUES (?, ?)',
          [VAULT_HEADER_ID, input.header]
        );
      }
      for (const record of input.puts) {
        if (record.id.startsWith(INTERNAL_RECORD_PREFIX)) {
          throw new Error('密文记录 ID 使用了保留前缀。');
        }
        await this.store.executeSql(
          'INSERT OR REPLACE INTO secureRecords (id, payload) VALUES (?, ?)',
          [record.id, record.payload]
        );
      }
      for (const id of input.deletes) {
        if (id.startsWith(INTERNAL_RECORD_PREFIX)) {
          throw new Error('密文记录 ID 使用了保留前缀。');
        }
        await this.store.executeSql('DELETE FROM secureRecords WHERE id = ?', [id]);
      }
      if (input.purgeLegacy === true) {
        await this.store.executeSql(
          'INSERT OR REPLACE INTO vaultState (id, value) VALUES (?, ?)',
          [LEGACY_PURGE_MARKER_ID, '1']
        );
      }
      this.store.commit();
    } catch (error) {
      this.store.rollBack();
      throw error as Error;
    }
    const persistedHeader = await this.vaultHeader();
    if (input.purgeLegacy === true && persistedHeader === null) {
      throw new Error('加密空间头部未持久化，旧数据已保留。');
    }
    this.vaultActive = persistedHeader !== null;
    if (input.purgeLegacy === true) {
      await this.purgeLegacyData();
    }
  }

  async vaultLegacyExport(): Promise<LegacyExport> {
    const groups = await this.queryRows(
      'SELECT id, name, parent_id, created_at, updated_at FROM groups ORDER BY created_at, id',
      [],
      (result: relationalStore.ResultSet): NoteGroup => this.readGroup(result)
    );
    const notes = await this.queryRows(
      'SELECT id, title, group_id, kind, privacy, sync_policy, preview, created_at, updated_at, revision, schema_version, content, deleted_at FROM notes ORDER BY updated_at DESC, id',
      [],
      (result: relationalStore.ResultSet): LegacyNote => {
        const summary = this.readSummary(result);
        return {
          id: summary.id,
          title: summary.title,
          groupId: summary.groupId,
          kind: summary.kind,
          privacy: summary.privacy,
          syncPolicy: summary.syncPolicy,
          preview: summary.preview,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          revision: summary.revision,
          schemaVersion: result.getLong(10),
          content: JSON.parse(result.getString(11)) as Object,
          deletedAt: result.isColumnNull(12) ? null : result.getString(12)
        };
      }
    );
    const attachmentRows = await this.queryRows(
      'SELECT id, file_name, mime_type, original_name, byte_length FROM attachments ORDER BY created_at, id',
      [],
      (result: relationalStore.ResultSet): LegacyAttachmentRow => ({
        attachment: {
          id: result.getString(0),
          mimeType: result.getString(2),
          originalName: result.getString(3),
          byteLength: result.getLong(4)
        },
        fileName: result.getString(1)
      })
    );
    const attachments: LegacyAttachment[] = [];
    for (const row of attachmentRows) {
      if (!MANAGED_ATTACHMENT_NAME.test(row.fileName)) {
        throw new Error('旧附件文件名无效，已停止迁移以保留原始数据。');
      }
      const path = this.attachmentsDirectory + '/' + row.fileName;
      const size = fileIo.statSync(path).size;
      if (size !== row.attachment.byteLength) {
        throw new Error('旧附件大小与索引不符，已停止迁移以保留原始数据。');
      }
      const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY);
      const buffer = new ArrayBuffer(size);
      let readLength: number = 0;
      try {
        readLength = fileIo.readSync(file.fd, buffer, { length: size });
      } finally {
        fileIo.closeSync(file.fd);
      }
      if (readLength !== size) {
        throw new Error('旧附件未能完整读取，已停止迁移以保留原始数据。');
      }
      const bytes = new Uint8Array(buffer.slice(0, readLength));
      attachments.push({
        id: row.attachment.id,
        mimeType: row.attachment.mimeType,
        originalName: row.attachment.originalName,
        byteLength: row.attachment.byteLength,
        dataBase64: this.base64.encodeToStringSync(bytes)
      });
    }
    return { groups, notes, attachments, dataDirectory: this.dataDirectory };
  }

  private async ensureLegacyReadable(): Promise<void> {
    if (this.vaultActive) {
      throw new Error('加密仓库已启用，请通过密文仓库读取笔记。');
    }
  }

  private async ensureLegacyWritable(): Promise<void> {
    if ((await this.vaultHeader()) !== null) {
      throw new Error('加密仓库已启用，禁止写入旧明文存储。');
    }
  }

  private async purgeLegacyData(): Promise<void> {
    fileIo.listFileSync(this.attachmentsDirectory).forEach((fileName: string): void => {
      if (!MANAGED_ATTACHMENT_NAME.test(fileName)) {
        return;
      }
      const path = this.attachmentsDirectory + '/' + fileName;
      const size = fileIo.statSync(path).size;
      const file = fileIo.openSync(path, fileIo.OpenMode.READ_WRITE);
      try {
        if (size > 0) {
          const zeroes = new ArrayBuffer(size);
          const written = fileIo.writeSync(file.fd, zeroes);
          if (written !== size) {
            throw new Error('旧附件安全清理未能完整覆盖文件。');
          }
          fileIo.fsyncSync(file.fd);
        }
      } finally {
        fileIo.closeSync(file.fd);
      }
      fileIo.unlinkSync(path);
    });

    await this.store.executeSql('PRAGMA secure_delete = ON');
    this.store.beginTransaction();
    try {
      await this.store.executeSql('DELETE FROM notes');
      await this.store.executeSql('DELETE FROM groups');
      await this.store.executeSql('DELETE FROM attachments');
      await this.store.executeSql('DELETE FROM sync_outbox');
      await this.store.executeSql('DELETE FROM sync_state');
      this.store.commit();
    } catch (error) {
      this.store.rollBack();
      throw error as Error;
    }
    await this.vacuumAndCheckpoint();
    await this.store.executeSql('DELETE FROM vaultState WHERE id = ?', [LEGACY_PURGE_MARKER_ID]);
    await this.vacuumAndCheckpoint();
  }

  private async vacuumAndCheckpoint(): Promise<void> {
    await this.store.executeSql('VACUUM');
    const result = await this.store.querySql('PRAGMA wal_checkpoint(TRUNCATE)');
    result.close();
  }
}
