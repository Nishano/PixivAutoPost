import fs from 'fs';
import path from 'path';

interface AdminProfile {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

interface AdminRegistryData {
  admins: number[];
  profiles: Record<string, Omit<AdminProfile, 'id'>>;
}

export class AdminRegistry {
  private readonly filePath = path.resolve(process.cwd(), 'data', 'admins.json');
  private readonly admins = new Set<number>();
  private readonly profiles = new Map<number, Omit<AdminProfile, 'id'>>();
  private readonly protectedIds: Set<number>;

  constructor(initialAdminIds: number[], protectedAdminIds: number[]) {
    this.protectedIds = new Set(protectedAdminIds);
    this.load();

    for (const id of initialAdminIds) {
      this.admins.add(id);
    }
    for (const id of protectedAdminIds) {
      this.admins.add(id);
    }

    this.save();
  }

  isAdmin(id: number): boolean {
    return this.admins.has(id);
  }

  addAdmins(ids: number[]): number[] {
    const added: number[] = [];
    for (const id of ids) {
      if (!this.admins.has(id)) {
        this.admins.add(id);
        added.push(id);
      }
    }
    this.save();
    return added;
  }

  removeAdmins(ids: number[]): { removed: number[]; blocked: number[] } {
    const removed: number[] = [];
    const blocked: number[] = [];

    for (const id of ids) {
      if (this.protectedIds.has(id)) {
        blocked.push(id);
        continue;
      }
      if (this.admins.has(id)) {
        this.admins.delete(id);
        removed.push(id);
      }
    }

    this.save();
    return { removed, blocked };
  }

  upsertProfile(user: any): void {
    if (!user?.id) {
      return;
    }

    const id = Number(user.id);
    if (!Number.isFinite(id)) {
      return;
    }

    const prev = this.profiles.get(id) || {};
    const next = {
      username: user.username || prev.username,
      firstName: user.first_name || prev.firstName,
      lastName: user.last_name || prev.lastName
    };

    this.profiles.set(id, next);
    this.save();
  }

  listAdmins(): Array<{ id: number; tag: string; nick: string; protected: boolean }> {
    return Array.from(this.admins)
      .sort((a, b) => a - b)
      .map((id) => {
        const p = this.profiles.get(id);
        const nick = p?.username ? `@${p.username}` : '@unknown';
        return {
          id,
          tag: `#${id}`,
          nick,
          protected: this.protectedIds.has(id)
        };
      });
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as AdminRegistryData;

      for (const id of data.admins || []) {
        if (Number.isFinite(id)) {
          this.admins.add(Number(id));
        }
      }

      for (const [idStr, profile] of Object.entries(data.profiles || {})) {
        const id = Number(idStr);
        if (!Number.isFinite(id)) continue;
        this.profiles.set(id, {
          username: profile.username,
          firstName: profile.firstName,
          lastName: profile.lastName
        });
      }
    } catch {
      // ignore malformed file and continue with defaults
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const profiles: Record<string, Omit<AdminProfile, 'id'>> = {};
    for (const [id, profile] of this.profiles.entries()) {
      profiles[String(id)] = profile;
    }

    const data: AdminRegistryData = {
      admins: Array.from(this.admins).sort((a, b) => a - b),
      profiles
    };

    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
