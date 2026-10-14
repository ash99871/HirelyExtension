import { HirelyError } from "./errors";
import { authenticatedRequest } from "./supabase";
import type { SavedAnswer } from "./types";

const COLUMNS = "id,user_id,question_text,answer_text,category,context,created_at,updated_at";

export async function listSavedAnswers(limit = 30): Promise<SavedAnswer[]> {
  const rows = await authenticatedRequest<SavedAnswer[]>(
    db => db.from("saved_answers").select(COLUMNS).order("updated_at", { ascending: false }).limit(limit),
    { idempotent: true }
  );
  return rows ?? [];
}

export async function saveAnswer(input: {
  question_text: string;
  answer_text: string;
  category?: string;
  context?: string;
}): Promise<SavedAnswer> {
  // Inserción: NO idempotente → el wrapper nunca la reintenta automáticamente.
  const row = await authenticatedRequest<SavedAnswer>(db =>
    db
      .from("saved_answers")
      .insert({
        question_text: input.question_text.trim(),
        answer_text: input.answer_text.trim(),
        category: input.category?.trim() || null,
        context: input.context?.trim() || null
      })
      .select()
      .single()
  );
  if (!row) throw new HirelyError("UNKNOWN");
  return row;
}

export async function deleteAnswer(id: string): Promise<void> {
  await authenticatedRequest(db => db.from("saved_answers").delete().eq("id", id), { idempotent: true });
}
