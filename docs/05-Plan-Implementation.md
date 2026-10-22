# Plan d'implémentation

**Date :** 12 octobre 2026
**État global :** l'application est fonctionnelle et déployée sur https://promographe-v2.azurewebsites.net. Il reste les étapes de livraison au client.

---

## 1. Phases réalisées ✅

| Phase | Contenu | Migrations |
|---|---|---|
| **1. Fondations** | Express, sessions SQL, connexion, invitations, rôles admin / responsable | 001 |
| **2. Commandes** | Catalogue par département, demandes multi-produits, approbation | 002, 003 |
| **3. Fournisseurs et budgets** | Fournisseurs, budgets annuels, tableau de bord | 004, 005 |
| **4. Comptes** | Noms complets, mot de passe oublié, changement de mot de passe, déconnexion des autres sessions | 006, 007 |
| **5. Infrastructure Azure dédiée** | Groupe `rg-promographe-v2` séparé des autres sites : App Service B1, Azure SQL serverless (offre gratuite), identité managée, Azure Communication Services pour les courriels | — |
| **6. Expérience admin** | Historique séparé, export CSV, catalogue en tableau par département, suppression de produits et de fournisseurs | 008 |
| **7. Notifications et profil** | Cloche avec son (sans courriel), page Profil, détection de changement de compte | — |
| **8. Administration** | Menu de gauche, ajouter / modifier / supprimer responsables, départements, fournisseurs | 009 |
| **9. Rôle Développeur** | Accès limité à l'invitation des administrateurs | 010 |
| **10. Données** | Import de 406 produits et 35 fournisseurs ; nettoyage des comptes et commandes de test | — |
| **11. Sécurité** | CSP stricte, en-têtes, limite de débit par compte, session fermée à la fermeture du navigateur, pare-feu SQL resserré | — |

**Qualité :** 26 tests automatisés (`npm test`), tous au vert.

## 2. Reste à faire avant la livraison

| # | Tâche | Qui | Dépend de | Coût |
|---|---|---|---|---|
| L1 | **Changer le mot de passe** du compte Développeur (Profil → Modifier le mot de passe) | Développeur | — | 0 $ |
| L2 | **Enregistrer le code dans git** (commit), puis le pousser vers le dépôt distant | Développeur | — | 0 $ |
| L3 | **Adresse définitive** : ajouter 2 lignes DNS (CNAME + TXT) pour `promographe-commande.arovahub.com` (GoDaddy) ou `commande.promographe.com` (ecmedia.ca) ; puis associer le domaine dans Azure, créer le certificat gratuit et mettre à jour `APP_BASE_URL` | Développeur + gestionnaire DNS | Accès DNS | 0 $ |
| L4 | **Inviter l'administrateur** de l'entreprise depuis la page Administrateurs | Développeur | L3 conseillé (les liens des courriels utilisent `APP_BASE_URL`) | 0 $ |
| L5 | **Saisir les vrais prix** des produits (actuellement 0,00 $) et les budgets annuels | Administrateur | L4 | 0 $ |
| L6 | **Transférer l'administration du serveur SQL** vers un compte ou un groupe de l'entreprise | Développeur + admin Microsoft de l'entreprise | Compte de l'entreprise | 0 $ |
| L7 | **Décider des droits Azure** du développeur après la livraison (garder pour la maintenance, ou retirer) | Entreprise | — | 0 $ |

## 3. Procédure de livraison

1. Faire L1 et L2.
2. Faire L3 et vérifier que `https://<nouvelle adresse>` affiche la page de connexion avec le cadenas.
3. Se connecter comme Développeur → **Inviter un administrateur** (nom et courriel du responsable chez Promographe).
4. L'administrateur accepte l'invitation, se connecte, vérifie le Tableau de bord, le Catalogue et l'Administration.
5. L'administrateur saisit les prix (L5), puis invite ses responsables de département.
6. Test réel : un responsable passe une demande → la cloche de l'admin sonne → approbation → la cloche du responsable sonne → la demande apparaît dans l'Historique et le CSV.
7. Faire L6 et L7.

## 4. Améliorations possibles (après la livraison)

| Priorité | Amélioration | Effort | Coût Azure |
|---|---|---|---|
| Haute | Activer « Se connecter avec Microsoft » pour les comptes de l'entreprise (code prêt ; il faut une inscription d'application créée par l'admin Microsoft) | 0,5 jour | 0 $ |
| Haute | Déploiement automatique depuis git (GitHub Actions) avec exécution des tests | 0,5 jour | 0 $ |
| Moyenne | Courriels envoyés depuis le domaine de l'entreprise (`noreply@…`) plutôt que `azurecomm.net` | 0,5 jour + DNS | 0 $ |
| Moyenne | Courriel à l'employé quand sa demande est décidée (optionnel, actuellement seulement la cloche) | 0,5 jour | ~0 $ |
| Moyenne | Import / export du catalogue en CSV depuis l'interface admin | 1 jour | 0 $ |
| Basse | Audit SQL, Azure Key Vault pour les secrets, réseau privé pour la base | 1 jour | quelques $/mois |
| Basse | Mise à jour de `mssql` dès qu'une version corrige `sprintf-js` | 0,25 jour | 0 $ |

## 5. Procédure pour une évolution future

1. Créer une branche, écrire le code et les tests (`npm test`).
2. Si le schéma change : ajouter `migrations/0NN_nom.sql` (idempotent) et l'inscrire dans `src/database.js`, avec l'équivalent dans `tests/support/memory-database.js`.
3. Ouvrir temporairement le pare-feu SQL à son IP → `npm run db:migrate` → refermer.
4. Déployer le code (zip) → vérifier le site en ligne.
5. Ne jamais toucher aux ressources des autres groupes (`rg-hub-prod`, `rg-promographe-app`, `rg-promographe-dev`, `Promotion-app`) : elles servent d'autres sites en production.
