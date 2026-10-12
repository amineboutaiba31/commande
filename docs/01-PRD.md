# PRD — Document des exigences produit

**Produit :** Promographe — Commandes d'achat par département
**Version :** 1.0 (livrable)
**Date :** 12 octobre 2026

---

## 1. Le problème

Chez Promographe, chaque département (Papeterie, Broderie, Sérigraphie, Entrepôt, Entretien, Lettrage) a besoin de fournitures. Sans outil commun :

- les demandes d'achat circulent par courriel, papier ou de vive voix, et se perdent ;
- l'administration ne voit pas en un coup d'œil ce qui attend une approbation ;
- il est difficile de suivre les dépenses par département par rapport à un budget annuel ;
- le catalogue des produits et de leurs fournisseurs n'est centralisé nulle part.

## 2. La solution

Une application web interne où :

1. chaque **responsable de département** commande dans le catalogue de **son** département ;
2. l'**administrateur** approuve ou refuse chaque demande, gère le catalogue, les fournisseurs, les départements, les comptes et les budgets ;
3. tout est **historisé** et **exportable en CSV**.

## 3. Objectifs

| Objectif | Mesure de succès |
|---|---|
| Centraliser toutes les demandes d'achat | 100 % des demandes passent par l'application |
| Accélérer l'approbation | L'admin est notifié d'une nouvelle demande en moins de 30 secondes |
| Maîtriser les budgets | Budget, dépensé et en attente visibles par département sur l'Accueil |
| Garder une trace | Chaque demande traitée est dans l'Historique et exportable en CSV |

## 4. Utilisateurs et rôles

| Rôle | Qui | Ce qu'il peut faire |
|---|---|---|
| **Développeur** | Le prestataire (Arovahub) | Uniquement inviter et retirer les **administrateurs** de l'entreprise. N'a **aucun** accès aux commandes, au catalogue ni aux employés. |
| **Administrateur** | La direction de Promographe | Tout gérer : commandes (approuver / refuser), catalogue, départements, fournisseurs, responsables, budgets, historique. |
| **Responsable de département** (employé) | Un employé par département ou plus | Commander dans le catalogue de son département, suivre ses demandes, consulter son historique. |

## 5. Fonctionnalités

### 5.1 Comptes et connexion
- Connexion par courriel et mot de passe (12 caractères minimum).
- Comptes créés **uniquement par invitation** : la personne reçoit un courriel et choisit elle-même son mot de passe (lien valable 24 h).
- « Mot de passe oublié » par courriel (lien valable 1 h).
- **Profil** : nom complet modifiable, courriel, rôle, département ; bouton « Modifier le mot de passe ».
- La session se ferme quand le navigateur est fermé, ou après 8 h sans activité.
- *Option prête mais non activée :* connexion « Se connecter avec Microsoft », avec redirection automatique pour un domaine donné.

### 5.2 Catalogue
- Produits rattachés à **un département**, avec description, fournisseur, prix unitaire (CAD), état « Disponible / Inactif ».
- L'admin choisit un département dans une liste et voit ses produits dans un **tableau** (nombre de produits par département affiché).
- Ajouter, modifier, supprimer un produit. Un produit supprimé disparaît du catalogue mais **reste dans l'historique** des commandes passées.
- Catalogue initial : 406 produits répartis dans 6 départements, avec 35 fournisseurs.

### 5.3 Commandes
- Le responsable crée une **demande** avec un ou plusieurs produits (1 à 50 lignes, quantités 1 à 10 000) et une note facultative.
- Le prix est **figé** au moment de la demande.
- Aucune limite au nombre de demandes.
- L'admin **approuve** ou **refuse**, avec une note de décision facultative.
- Onglet **Commandes** : seulement les demandes **en attente**.
- Onglet **Historique** : les demandes **approuvées / refusées**, consultables en tableau (« Visualiser ») et **téléchargeables en CSV** (format compatible Excel français).

### 5.4 Notifications
- **Cloche** dans l'en-tête avec compteur rouge :
  - admin : nombre de demandes en attente, son à l'arrivée d'une nouvelle demande ;
  - responsable : décisions non lues sur ses demandes, son à l'arrivée d'une décision.
- Vérification toutes les 30 secondes. Aucune notification par courriel pour les commandes.

### 5.5 Tableau de bord (Accueil, admin)
- Indicateurs : budget total, coût total des achats, en attente d'approbation, budget restant.
- Tableau par département : budget annuel modifiable, dépensé, en attente, restant, barre d'utilisation.
- Choix de l'année.

### 5.6 Administration (admin)
Page avec un **menu à gauche** :
- **Responsables** : inviter, modifier (nom, département), supprimer.
- **Départements** : ajouter, renommer, supprimer (refusé s'il reste des responsables ou des demandes en attente).
- **Fournisseurs** : ajouter, modifier, supprimer (les produits restent, sans fournisseur).

### 5.7 Espace Développeur
- Page unique « Administrateurs » : inviter un administrateur, renvoyer l'invitation, retirer l'accès.

## 6. Hors périmètre (version 1.0)

- Paiement, facturation ou envoi automatique des bons de commande aux fournisseurs.
- Gestion des stocks et des réceptions.
- Application mobile native (le site est utilisable sur téléphone).
- Plusieurs devises (CAD uniquement) et plusieurs langues (français uniquement).

## 7. Exigences non fonctionnelles

| Domaine | Exigence |
|---|---|
| Sécurité | Voir le [TRD](02-TRD.md) : mots de passe Argon2id, CSRF, CSP stricte, HTTPS, droits vérifiés côté serveur. |
| Confidentialité | Le développeur n'a pas accès aux données de l'entreprise via le site. |
| Disponibilité | Hébergement Azure App Service (Canada Centre). |
| Langue | Interface entièrement en français. |
| Compatibilité | Navigateurs récents (Chrome, Edge, Firefox, Safari), ordinateur et téléphone. |
| Coût | Environ 13 $/mois (serveur B1), base de données sur l'offre gratuite Azure SQL. |

## 8. Hypothèses et points ouverts

- Les **prix** du catalogue initial sont à 0,00 $ : l'administrateur doit saisir les vrais prix.
- **Adresse web définitive** à configurer : `promographe-commande.arovahub.com` (DNS GoDaddy) ou `commande.promographe.com` (DNS chez ecmedia.ca).
- Transfert de l'administration du serveur SQL vers un compte de l'entreprise à la livraison.
