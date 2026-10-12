const form = document.getElementById("loginForm");
const message = document.getElementById("message");
const submitButton = document.getElementById("submitButton");
let csrfToken;

const microsoftErrors = {
  microsoft_not_invited: "Ce compte Microsoft n’a pas été invité dans Promographe. Demande une invitation à ton administrateur.",
  microsoft_cancelled: "La connexion Microsoft a été annulée.",
  microsoft_expired: "La connexion Microsoft a expiré. Réessaie.",
  microsoft_failed: "La connexion Microsoft a échoué. Réessaie plus tard.",
  microsoft_unavailable: "La connexion Microsoft n’est pas configurée."
};
const loginError = new URLSearchParams(window.location.search).get("error");
if (microsoftErrors[loginError]) {
  message.textContent = microsoftErrors[loginError];
  window.history.replaceState(null, "", window.location.pathname);
}

let microsoftDomains = [];

function usesMicrosoft() {
  const email = form.elements.email.value.trim().toLowerCase();
  return microsoftDomains.includes(email.split("@").pop());
}

// Company addresses sign in with Microsoft: hide the password and redirect on submit.
function updatePasswordField() {
  const microsoft = usesMicrosoft();
  const password = form.elements.password;
  password.hidden = microsoft;
  password.required = !microsoft;
  form.querySelector("label[for=password]").hidden = microsoft;
  form.querySelector(".forgot").hidden = microsoft;
  submitButton.textContent = microsoft ? "Continuer avec Microsoft" : "Se connecter";
}

form.elements.email.addEventListener("input", updatePasswordField);

fetch("/api/auth/providers")
  .then(response => response.json())
  .then(providers => {
    document.getElementById("microsoftSignIn").hidden = !providers.microsoft;
    microsoftDomains = providers.microsoftDomains || [];
    updatePasswordField();
  })
  .catch(() => {});

fetch("/api/auth/csrf")
  .then(async response => {
    if (!response.ok) {
      throw new Error("Impossible d'initialiser la connexion. Réessaie plus tard.");
    }
    const data = await response.json();
    csrfToken = data.csrfToken;
  })
  .catch(error => {
    message.textContent = error.message;
    submitButton.disabled = true;
  });

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (usesMicrosoft()) {
    const email = form.elements.email.value.trim().toLowerCase();
    window.location.assign(`/api/auth/microsoft/login?login_hint=${encodeURIComponent(email)}`);
    return;
  }
  if (!csrfToken) {
    message.textContent = "La session n'est pas prête. Recharge la page et réessaie.";
    return;
  }

  submitButton.disabled = true;
  message.textContent = "";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({
        email: form.elements.email.value,
        password: form.elements.password.value
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "La connexion a échoué.");
    }
    window.location.assign("/");
  } catch (error) {
    message.textContent = error.message;
    submitButton.disabled = false;
  }
});
