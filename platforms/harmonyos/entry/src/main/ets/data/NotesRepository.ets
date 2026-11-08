import { relationalStore } from '@kit.ArkData';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';

export type NoteKind = 'richtext' | 'mindmap';

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

interface RichTextContent {
  type: 'doc';
  content: RichTextParagraph[];
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

export class NotesRepository {
  private readonly store: relationalStore.RdbStore;
  private readonly attachmentsDirectory: string;
  private readonly dataDirectory: string;

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
    return this.readNote(id);
  }

  async createNote(groupId: string | null, kind: NoteKind = 'richtext'): Promise<Note> {
    const id = util.generateRandomUUID();
    const timestamp = new Date().toISOString();
    let contentJson: string;
    if (kind === 'mindmap') {
      const children: MindMapBranch[] = [];
      const root: MindMapBranch = { id: util.generateRandomUUID(), text: '', children };
      const content: MindMapContent = { type: 'mindmap', root };
      contentJson = JSON.stringify(content);
    } else {
      const paragraph: RichTextParagraph = { type: 'paragraph' };
      const content: RichTextContent = { type: 'doc', content: [paragraph] };
      contentJson = JSON.stringify(content);
    }
    const title = kind === 'mindmap' ? '未命名思维导图' : '未命名笔记';
    await this.store.executeSql(
      'INSERT INTO notes (id, title, group_id, kind, privacy, sync_policy, schema_version, content, plain_text, preview, revision, server_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, title, groupId, kind, 'normal', 'localOnly', 1, contentJson, '', '', 1, 0, timestamp, timestamp]
    );
    return this.readNote(id);
  }

  async saveNote(input: NoteWrite): Promise<Note> {
    const title = input.title.trim() || '未命名笔记';
    const preview = input.plainText.replace(/\s+/g, ' ').slice(0, 180);
    const contentJson = JSON.stringify(input.content);
    const contentType = (JSON.parse(contentJson) as ContentTypeMarker).type;
    const kind: NoteKind = contentType === 'mindmap' ? 'mindmap' : 'richtext';
    await this.store.executeSql(
      'UPDATE notes SET title = ?, group_id = ?, kind = ?, content = ?, plain_text = ?, preview = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL',
      [title, input.groupId, kind, contentJson, input.plainText, preview, new Date().toISOString(), input.id]
    );
    return this.readNote(input.id);
  }

  async deleteNote(id: string): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.store.executeSql(
      'UPDATE notes SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL',
      [timestamp, timestamp, id]
    );
  }

  async createGroup(name: string): Promise<NoteGroup> {
    const id = util.generateRandomUUID();
    const timestamp = new Date().toISOString();
    await this.store.executeSql(
      'INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [id, name.trim(), timestamp, timestamp]
    );
    return this.readGroupById(id);
  }

  async renameGroup(id: string, name: string): Promise<NoteGroup> {
    await this.store.executeSql(
      'UPDATE groups SET name = ?, updated_at = ? WHERE id = ?',
      [name.trim(), new Date().toISOString(), id]
    );
    return this.readGroupById(id);
  }

  async deleteGroup(id: string): Promise<void> {
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
}
