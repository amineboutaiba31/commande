require("dotenv").config();
const { AzureDatabase } = require("../src/database");

async function main() {
  const database = await AzureDatabase.connect(process.env);
  try {
    console.log("Promographe Azure SQL schema is up to date.");
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error("Promographe database migration failed:", error.message);
  process.exitCode = 1;
});
