const form = document.getElementById("forgotForm");
const message = document.getElementById("message");
const submitButton = document.getElementById("submitButton");

async function readJson(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Une erreur est survenue.");
  }
  return data;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  submitButton.disabled = true;
  message.textContent = "";
  message.classList.remove("success");
  try {
    const { csrfToken } = await readJson(await fetch("/api/auth/csrf"));
    const result = await readJson(await fetch("/api/auth/password-reset/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ email: form.elements.email.value })
    }));
    form.hidden = true;
    message.classList.add("success");
    message.textContent = result.message;
  } catch (error) {
    message.textContent = error.message;
    submitButton.disabled = false;
  }
});
