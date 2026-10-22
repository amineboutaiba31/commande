# UML — Comment fonctionne Promographe

**Date :** 15 octobre 2026
Pour voir les diagrammes dans VS Code : ouvrir ce fichier puis **Ctrl+Maj+V** (aperçu).

---

## 1. Cas d'utilisation — qui fait quoi

```mermaid
flowchart LR
    DEV([👨‍💻 Développeur])
    DIR([👔 Directeur])
    CPT([💼 Comptable])
    RESP([🧑‍💼 Responsable])
    EMP([👷 Employé])

    subgraph Site Promographe
      UC1[Inviter / retirer un directeur]
      UC2[Faire une demande d'achat]
      UC3[Approuver / refuser les demandes<br/>de son département]
      UC4[Approuver / refuser : demande d'un responsable > 2 500 $<br/>ou département sans responsable]
      UC5[Voir toutes les demandes<br/>lecture seule]
      UC6[Voir les demandes<br/>de son département]
      UC7[Historique + export CSV]
      UC8[Gérer employés, départements,<br/>fournisseurs, catalogue, budgets]
      UC9[Nommer responsables et comptable,<br/>accepter les demandes de responsable]
      UC10[Voir les employés de l'entreprise]
      UC11[Profil : nom, département,<br/>mot de passe]
    end

    DEV --> UC1
    DIR --> UC2 & UC4 & UC5 & UC7 & UC8 & UC9 & UC11
    CPT --> UC2 & UC5 & UC7 & UC11
    RESP --> UC2 & UC3 & UC6 & UC7 & UC10 & UC11
    EMP --> UC2 & UC6 & UC7 & UC11
```

| Acteur | Demande approuvée automatiquement ? |
|---|---|
| Directeur | Oui, quel que soit le montant |
| Responsable | Oui jusqu'à 2 500 $ (pour son département) ; au-delà, elle va au Directeur |
| Comptable, Employé | Non : elle attend une décision |

---

## 2. Diagramme de classes — les données

```mermaid
classDiagram
    class Utilisateur {
      Id
      Email
      NomComplet
      Rôle : developer | admin (Directeur) | accountant | employee
      Actif
      DemandeResponsableDe : Département
    }
    class Département {
      Id
      Nom
      BudgetAnnuel
      Responsable : Utilisateur
    }
    class Fonction {
      Code : transmetteur, réception, comptabilité, direction…
    }
    class Fournisseur {
      Nom
      Contact, Courriel, Téléphone
    }
    class Produit {
      Nom
      Description (code fournisseur)
      PrixUnitaire
      Disponible
    }
    class Demande {
      Id
      Statut : en attente | approuvée | refusée
      Note
      NoteDeDécision
      DateCréation, DateDécision
      CopieNom/Courriel du demandeur
    }
    class LigneDeDemande {
      NomProduit (copie)
      PrixUnitaire (copie)
      Quantité
    }
    class Invitation {
      JetonHaché
      Expiration 24 h
    }

    Département "1" --> "0..*" Utilisateur : employés
    Département "0..1" --> "1" Utilisateur : responsable
    Utilisateur "1" --> "0..*" Fonction
    Département "1" --> "0..*" Produit : catalogue
    Fournisseur "0..1" --> "0..*" Produit
    Utilisateur "1" --> "0..*" Demande : crée
    Utilisateur "0..1" --> "0..*" Demande : décide
    Département "1" --> "0..*" Demande
    Demande "1" *-- "1..50" LigneDeDemande
    Produit "1" --> "0..*" LigneDeDemande
    Utilisateur "1" --> "0..*" Invitation
```

---

## 3. Séquence — première connexion avec Microsoft

```mermaid
sequenceDiagram
    actor E as Employé (@promographe.com)
    participant S as Site Promographe
    participant M as Microsoft 365
    participant B as Base de données

    E->>S: Clique « Se connecter avec Microsoft »
    S->>M: Redirection (annuaire Promographe)
    E->>M: Courriel + mot de passe Outlook (+ double authentification)
    M-->>S: Identité confirmée (courriel, nom, annuaire)
    S->>B: Ce courriel existe-t-il ?
    alt Compte déjà existant
        B-->>S: Oui → session ouverte, accès selon son rôle
    else Première visite
        S-->>E: Page « Bienvenue » : es-tu responsable ? quel département ?
        E->>S: Département choisi (+ « oui, responsable » éventuel)
        S->>B: Crée le compte Employé dans ce département
        opt A répondu « oui, responsable »
            S->>B: Enregistre une DEMANDE de responsable (aucun droit tant que non acceptée)
        end
        S-->>E: Entrée dans le site
    end
```

---

## 4. Séquence — une demande d'achat

```mermaid
sequenceDiagram
    actor EMP as Employé
    participant S as Site
    actor R as Responsable du département
    actor D as Directeur

    EMP->>S: Nouvelle demande (produits, quantités, note)
    S->>S: Calcule le total (prix figés)
    alt Le département a un responsable (quel que soit le montant)
        S-->>R: 🔔 Nouvelle demande à décider
        R->>S: Approuver ou Refuser (+ note)
    else Aucun responsable
        S-->>D: 🔔 Nouvelle demande à décider
        D->>S: Approuver ou Refuser (+ note)
    end
    S-->>EMP: 🔔 Réponse : approuvée / refusée
    S->>S: La demande passe de « Commandes » à « Historique »
```

---

## 5. Activité — qui décide d'une demande ?

```mermaid
flowchart TD
    A[Nouvelle demande] --> B{Demandeur = Directeur ?}
    B -- Oui --> AUTO[✅ Approuvée automatiquement]
    B -- Non --> C{Demandeur = responsable<br/>de ce département ?}
    C -- Oui --> C2{Total ≤ 2 500 $ ?}
    C2 -- Oui --> AUTO
    C2 -- Non --> DIR[Le Directeur décide]
    C -- Non --> E{Le département a<br/>un responsable ?}
    E -- Oui --> RESP[Le responsable décide,<br/>quel que soit le montant]
    E -- Non --> DIR
    RESP --> FIN[Approuvée ou refusée → Historique]
    DIR --> FIN
```

---

## 6. États — une demande et un compte

```mermaid
stateDiagram-v2
    direction LR
    state "Demande d'achat" as Demande {
      [*] --> EnAttente : créée
      [*] --> Approuvée : Directeur / responsable ≤ 2 500 $
      EnAttente --> Approuvée : décision
      EnAttente --> Refusée : décision
      Approuvée --> [*]
      Refusée --> [*]
    }
```

```mermaid
stateDiagram-v2
    direction LR
    state "Compte utilisateur" as Compte {
      [*] --> Invité : invitation par courriel
      [*] --> Actif : 1re connexion Microsoft
      Invité --> Actif : lien accepté (24 h)
      Actif --> Actif : changement de rôle / département
      Actif --> [*] : supprimé (effacé de la base ;<br/>les demandes restent dans l'historique)
      Invité --> [*] : supprimé
    }
```

---

## 7. Déploiement — où tourne le site

```mermaid
flowchart LR
    U[Navigateur<br/>ordinateur / téléphone] -- HTTPS --> APP

    subgraph Azure — groupe rg-promographe-v2
      APP[App Service promographe-v2<br/>Node.js / Express]
      SQL[(Azure SQL<br/>sql-promographe-v2 / promographe)]
      MAIL[Azure Communication<br/>Services — courriels]
    end

    ENTRA[Microsoft Entra ID<br/>annuaire Promographe]

    APP -- identité managée, sans mot de passe --> SQL
    APP -- invitations, mot de passe oublié --> MAIL
    APP -- « Se connecter avec Microsoft » --> ENTRA
```
