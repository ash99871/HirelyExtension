import { authenticatedRequest } from "./supabase";
import type { JsonRecord } from "./types";

export async function getOwnProfile(userId: string): Promise<JsonRecord | null> {
  const profile = await authenticatedRequest<JsonRecord>(
    db => db.from("profiles").select("*").eq("user_id", userId).maybeSingle(),
    { idempotent: true }
  );
  return profile ?? null;
}

/** Estudios del perfil (tabla `education`, ligada a profiles.id). Solo se usa para el nivel de estudios. */
export async function getEducationRows(profileId: string): Promise<JsonRecord[]> {
  const rows = await authenticatedRequest<JsonRecord[]>(
    db => db.from("education").select("level, degree, program").eq("profile_id", profileId),
    { idempotent: true }
  );
  return rows ?? [];
}

export function getDisplayName(profile: JsonRecord | null, email?: string): string {
  const first = String(profile?.["first_name"] ?? "").trim();
  const last = String(profile?.["last_name"] ?? "").trim();
  return `${first} ${last}`.trim() || email || "usuario";
}
