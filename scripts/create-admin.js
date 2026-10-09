require("dotenv").config();
const readline = require("readline");
const argon2 = require("argon2");
const { AzureDatabase } = require("../src/database");

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
      reject(new Error("Run this command in an interactive terminal so the password can be hidden."));
      return;
    }
    process.stdout.write(prompt);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    let value = "";
    const onKeypress = (character, key) => {
      if (key && (key.name === "return" || key.name === "enter")) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("keypress", onKeypress);
        process.stdout.write("\n");
        resolve(value);
      } else if (key && key.ctrl && key.name === "c") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("keypress", onKeypress);
        reject(new Error("Administrator provisioning cancelled."));
      } else if (key && key.name === "backspace") {
        value = value.slice(0, -1);
      } else if (character && !key.ctrl && !key.meta) {
        value += character;
      }
    };
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
  });
}

async function main() {
  const email = process.argv[2] && process.argv[2].trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Usage: npm run admin:create -- admin@company.example");
  }

  const password = await readHidden("Choose an administrator password (12-256 characters): ");
  const confirmation = await readHidden("Confirm the administrator password: ");
  if (password.length < 12 || password.length > 256) {
    throw new Error("The administrator password must contain 12 to 256 characters.");
  }
  if (password !== confirmation) {
    throw new Error("The passwords do not match.");
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const database = await AzureDatabase.connect(process.env);
  try {
    await database.createFirstAdmin(email, passwordHash);
    console.log(`Administrator ${email} created. The password was stored as an Argon2id hash.`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error("Administrator provisioning failed:", error.message);
  process.exitCode = 1;
});
