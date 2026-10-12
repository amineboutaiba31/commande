# TRD — Document des exigences techniques

**Produit :** Promographe — Commandes d'achat par département
**Date :** 12 octobre 2026

---

## 1. Architecture générale

```
 Navigateur (HTML/CSS/JS sans framework)
        │  HTTPS (TLS 1.2+), cookie de session
        ▼
 Azure App Service  « promographe-v2 »  (Linux, Node.js 22, plan B1)
   └─ server.js (Express 5)
        ├─ Sessions  ──────────────┐
        ├─ API REST /api/...       │  Identité managée (sans mot de passe)
        └─ Fichiers statiques      ▼
                         Azure SQL « sql-promographe-v2 / promographe »
                         (serverless, offre gratuite, auth Microsoft Entra uniquement)
        │
        └─ Courriels (invitations, mot de passe oublié)
                         Azure Communication Services Email « acs-promographe-v2 »
```

Une seule application Node.js sert à la fois l'API et les pages. Aucune étape de compilation (pas de bundler) : les fichiers de `public/` sont servis tels quels.

## 2. Pile technologique

| Couche | Technologie |
|---|---|
| Serveur | Node.js 22 LTS (Azure), Express 5 |
| Sessions | `express-session` + magasin SQL maison (`src/azure-session-store.js`) |
| Base de données | Azure SQL Database, pilote `mssql` (tedious) |
| Authentification à la base | `DefaultAzureCredential` : identité managée sur Azure ; Azure CLI ou VS Code en local |
| Mots de passe | `argon2` (Argon2id) |
| Courriel | Azure Communication Services (`@azure/communication-email`) ; SMTP possible via `nodemailer` |
| Connexion Microsoft (optionnelle) | `@azure/msal-node` (code d'autorisation + PKCE) |
| Limitation de débit | `express-rate-limit` |
| Front-end | HTML, CSS et JavaScript natifs (`public/`) |
| Tests | `node --test` avec une base en mémoire (`tests/support/memory-database.js`) |

## 3. Structure du code

| Chemin | Rôle |
|---|---|
| `server.js` | Création de l'application, sécurité, toutes les routes API |
| `src/database.js` | Accès SQL (requêtes paramétrées), migrations |
| `src/azure-session-store.js` | Stockage des sessions dans la table `PromographeSessions` |
| `src/invitation-mailer.js` | Courriels d'invitation et de réinitialisation |
| `src/microsoft-auth.js` | Connexion Microsoft Entra (optionnelle) |
| `migrations/001…010_*.sql` | Évolutions du schéma, idempotentes |
| `scripts/migrate.js` | Applique les migrations (`npm run db:migrate`) |
| `scripts/create-admin.js` | Crée le tout premier compte admin si aucun n'existe |
| `public/index.html` + `app.js` + `app.css` | Application principale (après connexion) |
| `public/login.*`, `forgot-password.*`, `reset-password.*`, `accept-invitation.*` | Pages publiques |
| `tests/auth.test.js` | 26 tests de bout en bout de l'API |

## 4. Configuration (variables d'environnement)

| Variable | Obligatoire | Rôle |
|---|---|---|
| `NODE_ENV` | Oui (prod) | `production` active les cookies sécurisés, HSTS, `trust proxy` |
| `DB_SERVER`, `DB_NAME` | Oui | Serveur et base Azure SQL |
| `DB_AUTH_CLIENT_ID` | Non | Identité managée attribuée par l'utilisateur, le cas échéant |
| `SESSION_SECRET` | Oui (prod) | Clé de signature des cookies (32 caractères ou plus) |
| `APP_BASE_URL` | Oui (prod) | URL publique HTTPS, utilisée dans les liens des courriels |
| `ACS_EMAIL_FROM` + `ACS_EMAIL_CONNECTION_STRING` (ou `ACS_EMAIL_ENDPOINT`) | Pour les courriels | Azure Communication Services |
| `SMTP_*` | Alternative | Envoi par SMTP à la place d'ACS |
| `AUTH_MICROSOFT_CLIENT_ID`, `_CLIENT_SECRET`, `_TENANT_ID` | Non | Active « Se connecter avec Microsoft » |
| `AUTH_MICROSOFT_DOMAINS` | Non | Domaines obligés de passer par Microsoft (désactivé actuellement) |

Sur Azure, ces valeurs sont dans les **paramètres de l'application**. Aucun secret n'est dans le code ni dans git (`.env` est ignoré).

## 5. Authentification et autorisation

### 5.1 Sessions
- Cookie `promographe.sid` : `HttpOnly`, `Secure`, `SameSite=Lax`, **sans date d'expiration** (supprimé à la fermeture du navigateur).
- Côté serveur : expiration après **8 h d'inactivité** (prolongée à chaque requête).
- `SessionVersion` : changer son mot de passe ou être supprimé invalide les autres sessions.
- La session est régénérée à la connexion (protection contre la fixation de session).

### 5.2 Contrôle d'accès (vérifié par le serveur)
| Middleware | Effet |
|---|---|
| `requireAuthenticated` | Session valide, compte actif, version de session à jour |
| `requireRole(...)` | Rôle autorisé, sinon 403 « Accès refusé. » |
| Verrou Développeur | Le rôle `developer` n'accède qu'à `/api/auth/*` et `/api/developer/*` |
| Filtrage par département | Un responsable ne voit que les produits et commandes de **son** département |

### 5.3 Jetons à usage unique
- Invitations (24 h) et réinitialisations (1 h) : jeton aléatoire de 48 octets envoyé par courriel ; seul son **SHA-256** est stocké.

## 6. Sécurité

| Mesure | Détail |
|---|---|
| Mots de passe | Argon2id, 12 à 256 caractères ; hachage factice pour égaliser le temps de réponse |
| CSRF | Jeton par session, exigé dans l'en-tête `X-CSRF-Token` pour toute écriture |
| Injection SQL | 100 % des requêtes paramétrées (`?` → `@pN`) |
| XSS | Aucune insertion de HTML brut côté client (`textContent` uniquement) ; échappement HTML dans les courriels |
| En-têtes | CSP stricte (`script-src 'self'`, `frame-ancestors 'none'`), X-Frame-Options DENY, nosniff, HSTS 1 an, Referrer-Policy, Permissions-Policy, COOP |
| Débit | Connexion : 10 essais / 15 min par IP **et** par compte ; liens d'invitation / réinitialisation : 20 / h par IP |
| Énumération | Messages identiques pour un compte existant ou non (connexion, mot de passe oublié) |
| Erreurs | Message générique côté client, détail seulement dans les journaux |
| Taille des requêtes | JSON limité à 10 Ko |

## 7. Hébergement Azure

Toutes les ressources sont dans le groupe **`rg-promographe-v2`**, séparé des autres sites.

| Ressource | Nom | Configuration |
|---|---|---|
| Plan App Service | `plan-promographe-v2` | Linux B1, Canada Centre |
| Site web | `promographe-v2` | Node 22 LTS, HTTPS uniquement, TLS 1.2 min., FTP désactivé, authentification de base du déploiement désactivée, identité managée système |
| Serveur SQL | `sql-promographe-v2` | Auth Microsoft Entra uniquement, TLS 1.2 min., pare-feu « AllowAzure » seulement |
| Base | `promographe` | Serverless GP Gen5, offre gratuite (pause automatique si la limite est atteinte), chiffrement TDE |
| Courriel | `email-promographe-v2` + `acs-promographe-v2` | Domaine géré par Azure, expéditeur `DoNotReply@…azurecomm.net` |

**Droits de l'identité managée du site sur la base :** `db_datareader`, `db_datawriter` (pas de droit de modifier le schéma).

## 8. Déploiement

1. **Migrations** (si le schéma change) : depuis un poste autorisé, ouvrir temporairement le pare-feu SQL à son IP, puis `npm run db:migrate`, puis refermer.
2. **Code** : archive zip de `package.json`, `package-lock.json`, `server.js`, `src/`, `public/`, `migrations/`, `scripts/` → `az webapp deploy --type zip`. Azure exécute `npm install` sur Linux (`SCM_DO_BUILD_DURING_DEPLOYMENT=true`).
3. **Démarrage** : `npm start`.

Toujours appliquer la migration **avant** de déployer le code qui en dépend.

## 9. Tests

- `npm test` : 26 tests couvrant l'authentification, les invitations, les rôles, les commandes, les suppressions, le tableau de bord, la session et les en-têtes de sécurité.
- La base de test (`MemoryDatabase`) reproduit le comportement de `AzureDatabase`. Toute nouvelle méthode SQL doit avoir son équivalent en mémoire.

## 10. Limites connues

- 3 vulnérabilités **modérées** dans `sprintf-js` (dépendance de `mssql`) : déni de service non déclenchable par un utilisateur. Attendre une mise à jour de `mssql` ; ne pas lancer `npm audit fix --force`.
- Le magasin de limitation de débit est en mémoire (une seule instance) : à revoir si le site passe à plusieurs instances.
- La cloche interroge le serveur toutes les 30 s (pas de WebSocket).
- Les « décisions déjà vues » d'un employé sont mémorisées par navigateur (localStorage).
