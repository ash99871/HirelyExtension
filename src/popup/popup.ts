import { currentUser, signIn, signOut } from "../shared/auth-service";
import { listSavedAnswers, saveAnswer, deleteAnswer } from "../shared/answers-service";
import { getOwnProfile, getDisplayName } from "../shared/profile-service";
import { getConfig } from "../shared/config";
import { HirelyError, userMessage } from "../shared/errors";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const loginView = byId<HTMLElement>("login-view");
const homeView = byId<HTMLElement>("home-view");
const notice = byId<HTMLElement>("notice");
const answersList = byId<HTMLElement>("answers-list");

function showNotice(message: string, kind: "success" | "error" = "success") {
  notice.textContent = message;
  notice.className = `notice show ${kind}`;
}
function hideNotice() { notice.className = "notice"; }
function showSignedIn(isSignedIn: boolean) {
  loginView.hidden = isSignedIn;
  homeView.hidden = !isSignedIn;
}

/** Muestra el error con un mensaje controlado; si la sesión se perdió, vuelve al login. */
function reportError(error: unknown) {
  if (HirelyError.is(error, "AUTH_EXPIRED", "AUTH_REQUIRED")) showSignedIn(false);
  showNotice(userMessage(error), "error");
}

async function refreshAnswers() {
  const answers = await listSavedAnswers();
  answersList.innerHTML = "";
  if (!answers.length) {
    answersList.innerHTML = '<p class="muted small">Todavía no has guardado respuestas.</p>';
    return;
  }
  for (const answer of answers) {
    const item = document.createElement("div");
    item.className = "answer-item";
    const question = document.createElement("strong");
    question.textContent = answer.question_text;
    const body = document.createElement("p");
    body.textContent = answer.answer_text;
    const actions = document.createElement("div");
    actions.className = "answer-actions";
    const remove = document.createElement("button");
    remove.className = "delete";
    remove.textContent = "Eliminar";
    remove.addEventListener("click", async () => {
      try {
        await deleteAnswer(answer.id);
        await refreshAnswers();
        showNotice("Respuesta eliminada.");
      } catch (error) {
        reportError(error);
      }
    });
    actions.append(remove);
    item.append(question, body, actions);
    answersList.append(item);
  }
}

async function loadHome() {
  const user = await currentUser();
  if (!user) { showSignedIn(false); return; }
  showSignedIn(true);
  byId<HTMLElement>("user-email").textContent = user.email ?? "";
  try {
    const profile = await getOwnProfile(user.id);
    byId<HTMLElement>("welcome").textContent = `Hola, ${getDisplayName(profile, user.email)}`;
    byId<HTMLElement>("profile-summary").textContent = profile
      ? "Datos listos para autocompletar formularios."
      : "No se encontró un perfil. Completa tu perfil en la web de Hirely.";
  } catch (error) {
    byId<HTMLElement>("profile-summary").textContent = "No se pudo cargar el perfil.";
    reportError(error);
    if (HirelyError.is(error, "AUTH_EXPIRED", "AUTH_REQUIRED")) return;
  }
  try { await refreshAnswers(); }
  catch (error) { reportError(error); }
}

byId<HTMLFormElement>("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  hideNotice();
  const email = byId<HTMLInputElement>("email").value.trim();
  const password = byId<HTMLInputElement>("password").value;
  const submit = byId<HTMLButtonElement>("login-form").querySelector<HTMLButtonElement>('button[type="submit"]')!;
  submit.disabled = true;
  submit.textContent = "Entrando…";
  try {
    await signIn(email, password);
    await loadHome();
    showNotice("Sesión iniciada.");
  } catch (error) {
    showNotice(userMessage(error), "error");
  } finally {
    submit.disabled = false;
    submit.textContent = "Entrar";
  }
});

byId<HTMLButtonElement>("logout").addEventListener("click", async () => {
  await signOut();
  showSignedIn(false);
  showNotice("Sesión cerrada.");
});

byId<HTMLButtonElement>("autofill").addEventListener("click", async () => {
  const result = byId<HTMLElement>("fill-result");
  result.textContent = "Abriendo el asistente en la pestaña activa…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
      throw new Error("Abre una página web normal con el formulario que quieres completar.");
    }
    await chrome.tabs.sendMessage(tab.id, { type: "HIRELY_AUTOFILL" });
    result.textContent = "Asistente abierto. Revisa las sugerencias en la página.";
  } catch (error) {
    result.textContent = HirelyError.is(error)
      ? userMessage(error)
      : "No se pudo conectar. Recarga la página después de instalar la extensión e inténtalo otra vez.";
  }
});

byId<HTMLFormElement>("answer-form").addEventListener("submit", async event => {
  event.preventDefault();
  const question = byId<HTMLTextAreaElement>("question").value.trim();
  const answer = byId<HTMLTextAreaElement>("answer").value.trim();
  const category = byId<HTMLInputElement>("category").value.trim();
  if (!question || !answer) { showNotice("Completa la pregunta y la respuesta.", "error"); return; }
  try {
    await saveAnswer({ question_text: question, answer_text: answer, category });
    byId<HTMLTextAreaElement>("question").value = "";
    byId<HTMLTextAreaElement>("answer").value = "";
    byId<HTMLInputElement>("category").value = "";
    await refreshAnswers();
    showNotice("Respuesta guardada para futuras postulaciones.");
  } catch (error) {
    reportError(error);
  }
});

try {
  getConfig(); // valida que la configuración inyectada en el build exista
  void loadHome().catch(reportError);
} catch (error) {
  reportError(error);
}
