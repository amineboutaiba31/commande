const form = document.getElementById("welcomeForm");
const info = document.getElementById("welcomeInfo");
const message = document.getElementById("message");
const submitButton = document.getElementById("submitButton");

async function readJson(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Une erreur est survenue.");
  }
  return data;
}

// First Microsoft sign-in of a company account: choose the department, then the account is created.
async function initialize() {
  const pending = await readJson(await fetch("/api/auth/onboarding"));
  info.textContent = `${pending.fullName || pending.email}, choisis ton département pour terminer la création de ton compte.`;
  const select = form.elements.departmentId;
  pending.departments.forEach((department) => select.add(new Option(department.name, department.id)));
  form.hidden = false;
}

const isManager = () => form.elements.isManager.value === "yes";

form.addEventListener("change", () => {
  document.getElementById("departmentLabel").textContent = isManager()
    ? "Quel département diriges-tu ?"
    : "À quel département appartiens-tu ?";
  document.getElementById("managerNote").hidden = !isManager();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  message.textContent = "";
  try {
    const { csrfToken } = await readJson(await fetch("/api/auth/csrf"));
    await readJson(await fetch("/api/auth/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ departmentId: Number(form.elements.departmentId.value), requestManager: isManager() })
    }));
    window.location.assign("/");
  } catch (error) {
    message.textContent = error.message;
    submitButton.disabled = false;
  }
});

initialize().catch((error) => {
  info.textContent = error.message;
  const link = document.createElement("a");
  link.href = "/login.html";
  link.textContent = "Retour à la connexion";
  message.replaceChildren(link);
});
