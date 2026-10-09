const session = require("express-session");

class AzureSessionStore extends session.Store {
  constructor(database) {
    super();
    this.database = database;
    this.cleanupInterval = setInterval(() => {
      this.database.query(
        "DELETE FROM dbo.PromographeSessions WHERE ExpiresAt <= ?",
        [Date.now()]
      ).catch((error) => {
        console.error("Promographe session cleanup failed:", error.message);
      });
    }, 60 * 60 * 1000);
    this.cleanupInterval.unref();
  }

  get(sid, callback) {
    this.database.query(`
      SELECT SessionData AS session_data, ExpiresAt AS expires_at
      FROM dbo.PromographeSessions WHERE Sid = ?
    `, [sid]).then(async (result) => {
      const row = result.recordset[0];
      if (!row) {
        return callback(null, null);
      }
      if (Number(row.expires_at) <= Date.now()) {
        await this.database.query(
          "DELETE FROM dbo.PromographeSessions WHERE Sid = ?",
          [sid]
        );
        return callback(null, null);
      }
      callback(null, JSON.parse(row.session_data));
    }).catch(callback);
  }

  set(sid, value, callback = () => {}) {
    const expires = value.cookie && value.cookie.expires
      ? new Date(value.cookie.expires).getTime()
      : Date.now() + 8 * 60 * 60 * 1000;
    this.database.query(`
      MERGE dbo.PromographeSessions WITH (HOLDLOCK) AS target
      USING (SELECT ? AS Sid, ? AS SessionData, ? AS ExpiresAt) AS source
      ON target.Sid = source.Sid
      WHEN MATCHED THEN UPDATE SET
        SessionData = source.SessionData, ExpiresAt = source.ExpiresAt
      WHEN NOT MATCHED THEN INSERT (Sid, SessionData, ExpiresAt)
        VALUES (source.Sid, source.SessionData, source.ExpiresAt);
    `, [sid, JSON.stringify(value), expires]).then(() => callback(null)).catch(callback);
  }

  touch(sid, value, callback = () => {}) {
    const expires = value.cookie && value.cookie.expires
      ? new Date(value.cookie.expires).getTime()
      : Date.now() + 8 * 60 * 60 * 1000;
    this.database.query(
      "UPDATE dbo.PromographeSessions SET ExpiresAt = ? WHERE Sid = ?",
      [expires, sid]
    ).then(() => callback(null)).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    this.database.query(
      "DELETE FROM dbo.PromographeSessions WHERE Sid = ?",
      [sid]
    ).then(() => callback(null)).catch(callback);
  }

  close() {
    clearInterval(this.cleanupInterval);
  }
}

module.exports = { AzureSessionStore };
