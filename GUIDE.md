# Guide d'utilisation de yang-browser-engine

`yang-browser-engine` est un moteur YANG 1.1 écrit en TypeScript et conçu pour
tourner **dans le navigateur, sans serveur** : il analyse des sources YANG
(grammaire RFC 7950), construit l'ensemble de modules transitif, compile les
modèles de données en schéma, puis valide des arbres d'instance XML contre ce
schéma. Il embarque aussi des outils Nomina (aide à la saisie, candidats), un
adaptateur JSON RFC 7951, des constructeurs de requêtes RESTCONF (RFC 8040) et
une CLI de précompilation pour la production.

Ce guide explique **comment utiliser le projet** de bout en bout. La couverture
normative détaillée (ce qui est conforme, partiel ou exclu) vit dans
[CONFORMANCE.md](CONFORMANCE.md) ; les exemples exécutables hors bibliothèque
sont dans [examples/](examples/). Ce guide ET la liste des API publiques sont
contrôlés par un test de régression : `npx vitest run
tests/documentation.test.ts` échoue si le guide cite une API qui n'existe pas
dans le baril public.

## 1. Installation et imports

```sh
npm install yang-browser-engine
```

Le paquet expose un **seul point d'entrée** (la carte `exports` ne contient
que `.`) : importez toujours depuis la racine. Les fichiers `.d.ts` sont
embarqués, la bibliothèque reste utilisable en TypeScript sans configuration :

```ts
import {
  parseYang,
  resolveModuleSet,
  compileYangModules,
  validateDataTree,
} from "yang-browser-engine";
```

## 2. Le pipeline complet

Toute utilisation suit la même chaîne : **parse → résolution → compilation →
validation**. Lazy errors ne sont pas tolérées : chaque étape rapporte ses
propres diagnostics et refuse d'inventer des données pour continuer.

| Étape | API | Entrée | Sortie |
| --- | --- | --- | --- |
| Analyse syntaxique | `parseYang` | texte YANG | `YangModule` (AST) |
| Fermeture des modules | `resolveModuleSet` | racines + chargeur | `YangModuleSet` |
| Compilation | `compileYangModules` | module set | `CompiledYangSchema` |
| Validation d'instance | `validateDataTree` | schéma + document XML | statut + problèmes |
| Candidats de saisie | `evaluateCandidates` | schéma + document + chemin | évaluations |
| Aides de formulaire | `createFormModel` | `YangModule` | champs typés |

```ts
import { parseYang } from "yang-browser-engine";

const source = `
  module acme-router {
    yang-version 1.1;
    namespace "urn:example:acme-router";
    prefix ar;
    revision 2026-01-01;
    container interfaces {
      list interface {
        key "name";
        leaf name { type string; }
        leaf speed { type uint32; }
      }
    }
  }
`;

let root;
try {
  root = parseYang(source);
} catch (error) {
  if (error instanceof YangSyntaxError) {
    console.error(`YANG invalide ligne ${error.line}: ${error.message}`);
  }
  throw error;
}
```

`parseYang` construit un **AST générique localisé à la source** : chaque
statement de l'arbre porte ses positions, ce qui permet aux diagnostics des
étapes suivantes de citer la ligne fautive. `YangSyntaxError` porte `line`,
`column` et `message`.

### 2.1 Télécharger et résoudre les imports

Le moteur ne sait PAS lire des fichiers : vous fournissez un **chargeur**
objet exposant `loadModule(name, revision?)` (et `loadSubmodule(name,
revision?)` si vos modules utilisent `include`) ; chaque charge peut rendre le
texte source, un module déjà parsé, ou `undefined` quand rien n'existe. Le moteur l'appelle pour chaque import transitif, avec
les garanties suivantes : la boucle d'import est détectée, les budgets
dépassés interrompent la résolution, et les racines doivent être fournies
comme modules déjà parsés (le chargeur sert uniquement les dépendances).

```ts
import { parseYang, resolveModuleSet } from "yang-browser-engine";

const root = parseYang(source);
const controller = new AbortController();

const loader = {
  async loadModule(name: string) {
    const response = await fetch(`/yang/${name}.yang`);
    if (!response.ok) return undefined;                        // module introuvable → diagnostic
    return response.text();
  },
};

const set = await resolveModuleSet([root], loader, {
  signal: controller.signal,
  budget: {
    maxModules: 200,
    maxSubmodules: 200,
    maxDepth: 20,
    maxSourceCharacters: 8_000_000,
    deadlineMs: 30_000,
  },
});

if (set.diagnostics.length > 0) {
  for (const diagnostic of set.diagnostics) {
    console.error(`résolution : ${diagnostic.code} – ${diagnostic.message}`);
  }
  throw new Error("fermeture de modules incomplète");
}
```

Le résultat `YangModuleSet` contient `roots`, `modules`, `submodules` et
`diagnostics` (codes `missing-module`, `import-cycle`, `include-cycle`,
`duplicate-revision`, `ambiguous-revision`, `unexpected-document`,
`invalid-belongs-to`, `budget-exceeded`, `cancelled`). Sans option `budget`, la résolution reste **illimitée**
: passez toujours un budget en environnement non maîtrisé (voir §8).

### 2.2 Compiler le schéma

`compileYangModules` transforme le module set en `CompiledYangSchema` :
modèles de données assemblés (augments appliqués, deviates intégrés),
identités, enums, bits et fonctions attachés à leurs déclarations. Les
diagnostics de compilation sont des problèmes **réparables** ou des fois où le
moteur garde un comportement défini : lisez-les, décidez, puis validez.

```ts
import { compileYangModules } from "yang-browser-engine";

const schema = compileYangModules(set, {
  enabledFeatures: new Set(["acme-router:dual-stack"]),
  budget: { maxSchemaNodes: 50_000 },
});

for (const diagnostic of schema.diagnostics) {
  console.error(`compilation : ${diagnostic.code} – ${diagnostic.message}`);
}
```

Par défaut **tous les `feature` sont disponibles** ; passez `enabledFeatures`
pour réduire à un profil précis. L'option `budget.maxSchemaNodes` plafonne la
taille du schéma produit — un module hostile ne doit jamais pouvoir gonfler
l'objet sans limite.

### 2.3 Valider une instance

La validation d'instance vérifie un arbre d'instance XML (clés, cardinalités,
`mandatory`, `unique`, leafrefs, instance-identifiers, `must`, `when`) et rend
un statut à trois états :

- `valid` — aucune violation constatée ;
- `invalid` — au moins une violation déterminée (problème `code` + `path`) ;
- `indeterminate` — des contraintes n'ont pas pu être évaluées (ex. XPath
  non supporté) ; le problème identifie les contraintes en cause.

```ts
import { validateDataTree } from "yang-browser-engine";

const instanceDoc = new DOMParser().parseFromString(instanceXml, "text/xml");

const result = validateDataTree(schema, instanceDoc, {
  includeState: false,
  deadlineMs: 5_000,
  signal: controller.signal,
});

if (result.status !== "valid") {
  for (const issue of result.issues) {
    console.error(`${issue.code} @ ${issue.path} : ${issue.message}`);
  }
}
```

Codes de problème produits (`ValidationIssue.code`, chacun documenté dans
`src/validation/validate-instance.ts` à côté de la règle RFC 7950 qu'il
implémente) :

| Code | Signification |
| --- | --- |
| `too-few-elements` | `min-elements` non atteint (liste/leaf-list) |
| `too-many-elements` | `max-elements` dépassé |
| `missing-key` | clé d'entrée de liste absente |
| `duplicate-key` | deux entrées partagent une même clé (`key`) |
| `missing-mandatory` | `mandatory true` non présent |
| `missing-choice` | aucun noeud présent pour un `choice` obligatoire |
| `unique-violation` | two fils avec une valeur « unique » identique |
| `leafref-dangling` | valeur `leafref` sans cible (`require-instance`) |
| `instance-identifier-invalid` | instance-identifier syntaxiquement faux |
| `instance-identifier-dangling` | instance-identifier sans noeud réel |
| `must-unmet` | expression `must` fausse |
| `when-unexpected-node` | noeud présent alors que son `when` est faux |
| `cancelled` | validation interrompue par le signal/délai |

## 3. Lire le schéma compilé

`schema.modules` expose un `CompiledModule` par module compilé, avec les
modèles de données assemblés. Le format de chaque noeud est documenté dans
[docs/schema.md](docs/schema.md). Deux raccourcis utiles : les chemins de
schémas (`acme-rooter:interfaces/acme-router:interface`) servent d'identifiants
stables dans les API ci-dessous, et le moteur sérialise les entiers 64 bits et
les `decimal64` en chaînes — jamais en nombres JavaScript.

## 4. Candidats de saisie (`evaluateCandidates`)

Une interface de saisie a besoin des **valeurs acceptables** d'un noeud : les
valeurs d'enum, les bits, les unes des identités dérivées, les valeurs déjà
clés d'une liste référencée par un leafref... `evaluateCandidates` évalue
chaque candidat possibles les contraintes du schéma et rend un statut par
candidat.

```ts
import { evaluateCandidates } from "yang-browser-engine";

const result2 = evaluateCandidates(
  schema,
  instanceDoc,
  "/acme-router:interfaces/acme-router:interface/acme-router:speed",
  { bitsSelection: ["notify", "trap"], signal: controller.signal, deadlineMs: 5_000 },
);

for (const candidate of result2.candidates) {
  console.log(candidate.value, candidate.status, candidate.reasons.length ? candidate.reasons : "");
}
```

`result2.domain` indique le type de domaine évalué (`none` quand le noeud n'a
pas de domaine fini — les candidats sont alors vides). L'option
`bitsSelection` permet d'évaluer les bits **combinés** à une sélection
existante. Les XPath des contraintes qui échouent à l'évaluation marquent le
candidat `indeterminate` (jamais « valide » par silence).

## 5. Aides de formulaire (`createFormModel`)

`createFormModel` transforme un module **parsé** en métadonnées de
formulaire : champs (`FormField`), types d'origine YANG, contraintes à
évaluer, opérations RPC. C'est un modèle neutre, sans aucun DOM : la
couche UI (React, Lit, …) reste yours.

```ts
import { canonicalFormOf, createFormModel, validateFormValue } from "yang-browser-engine";

const model = createFormModel(root, { modules: [otherParsedModule] });
const field = model.fields.find((candidate) => candidate.path === "/acme-router:interfaces/acme-router:interface/acme-router:speed")!;

const verdict = validateFormValue(field, "9000");
if (verdict.status !== "valid") {
  for (const problem of verdict.errors) console.error(`${problem.code}: ${problem.message}`);
}

const normalized = canonicalFormOf(field, "9000");
```

`validateFormValue` retourne aussi `pending` : la liste des contraintes
(`must`, `when`, `if-feature`) que le moteur ne peut pas évaluer à ce niveau —
l'UI doit les considérer comme **peut-être invalides**, pas valides. Enfin,
`canonicalFormOf(field, value)` normalise une saisie (booléen, décimal, bits…)
avant envoi.

**Limite connue (honnêteté, voir §87 de la roadmap)** : le modèle de
formulaire est construit sur l'AST source et **ignore `uses`/`augment`
(slots réutilisables), les `if-feature` au niveau option et l'exclusivité des
`case` d'un `choice`** — le champ du schéma développé complet est couvert par
la roadmap ouverte.

## 6. Arbre accessible et contraintes XPath

Les expressions `must`/`when` compilent et s'évaluent contre un **arbre
accessible** : un document annexe où le moteur projette vos données selon le
contexte voulu (datastore de configuration, datastore d'état, entrée/sortie de
`rpc`/`action`) avec les valeurs par défaut en place. L'option `operation`
complète le contexte pour les contextes d'opération (`rpc-input`,
`rpc-output`, `action-input`, `action-output`).

```ts
import { buildAccessibleTree, createConstraintEvaluator } from "yang-browser-engine";

const tree = buildAccessibleTree(schema, instanceDoc, { context: "datastore-config" });
// contextes d'opération : { context: "rpc-input", operation: "shutdown" }

const evaluator = createConstraintEvaluator(schema);
const probe = instanceDoc.querySelector("interface");
if (probe) {
  for (const constraint of evaluator.evaluateNode(probe)) {
    console.log(`${constraint.kind} ${constraint.status} : ${constraint.expression}`);
  }
}
tree.document;    // le document projeté (défauts inclus)
tree.contextNode; // le noeud de contexte pour l'évaluation XPath
```

Un XPath qui ne peut pas être évalué (fonction manquante, erreur d'arbre)
produit le statut `indeterminate` avec le motif — jamais un silence.

## 7. Adapter du JSON (RFC 7951) aux documents XML

Pour parler à un serveur RESTCONF il faut dé/sérialiser le JSON `iana-.+
yang-data` en arbres XML et revenir. L'adaptateur règle les pièges connus:
entiers 64 bits et `decimal64` en chaînes (`int64`/`uint64` JS-safe),
`leaf-list` vide représenté `[null]`, `bits` en chaîne séparée par espaces,
`identityref` qualifié par le module, noms qualifiés uniquement aux
changements d'espace de noms.

```ts
import {
  documentToYangJson,
  parseYang,
  yangJsonToDocument,
  YangJsonError,
} from "yang-browser-engine";

const tree2 = yangJsonToDocument(schema, await fetch("/restconf/data/x").then((r) => r.json()), {
  document: new DOMParser().parseFromString("<x/>", "text/xml"),
});

const roundTrip = documentToYangJson(schema, tree2);
JSON.stringify(roundTrip);
```

L'adaptateur remplace le documentElement du document passé en option (un
document presque vide suffit ; l'option attend exactement
`{ document: Document }`). Toute violation de forme est une `YangJsonError`
portant le **chemin JSON** du membre fautif — le corps du serveur est refusé
explicitement, jamais interprété approximativement.

## 8. RESTCONF : chargement de schéma, librairie et requêtes

### 8.1 Charger les modules depuis le serveur

Un serveur RESTCONF expose sa librairie de schémas
(RFC 8040 `ietf-yang-library:modules-state`) avec des `location` par module.
`createRestconfModuleLoader` en fait un **chargeur compatible
`resolveModuleSet`** : le pipeline du §2 reste le même, seul le transport
change.

```ts
import { createRestconfModuleLoader, resolveModuleSet, parseYang } from "yang-browser-engine";

const restconfLoader = createRestconfModuleLoader({
  baseUrl: "https://host/restconf",
  libraryResource: "ietf-yang-library:modules-state",
});

const rootModule = parseYang(rootSource);
const set2 = await resolveModuleSet([rootModule], restconfLoader, {
  budget: { maxModules: 200, maxSourceCharacters: 8_000_000, deadlineMs: 30_000 },
});
```

Le chargeur enregistre les entrées de librairie au premier accès (une seule
requête `modules-state`) puis charge chaque module via son `location`. Les
option `fetchImpl` et `signal` permettent l'injection de test et
l'annulation coopérative.

### 8.2 Auditer les révisions (schéma embarqué vs serveur)

Avant de faire confiance à un schéma précompilé invoqué côté navigateur,
comparez-le avec la librairie du serveur :
`yangLibraryInventory(payload)` accepte une charge utile `modules-state` ou
`yang-library`, et `findSchemaLibraryMismatches(schema, inventory)` liste les
écarts.

```ts
import {
  deserializeCompiledSchema,
  findSchemaLibraryMismatches,
  yangLibraryInventory,
} from "yang-browser-engine";

const artifact = await fetch("/schema/yang-schema.json").then((response) => response.json());
const embedded = deserializeCompiledSchema(artifact);
const library = yangLibraryInventory(await fetch("/restconf/data/ietf-yang-library:modules-state").then((r) => r.json()));
const mismatches = findSchemaLibraryMismatches(embedded, library);
for (const gap of mismatches) {
  console.warn(`${gap.name} (${gap.kind}) : schéma=${gap.schemaRevision ?? "—"} serveur=${gap.libraryRevision ?? "—"}`);
}
if (mismatches.length > 0) throw new Error("schéma et serveur divergent : refusez la session");
```

`SchemaRevisionMismatch.kind` vaut `only-in-schema`, `only-in-library`,
`revision-mismatch` ou `schema-parity` (présent des deux côtés, révisions
identiques). Rejeter la session en cas d'écart évite de valider des données
contre un schéma que le serveur ne reconnait pas.

### 8.3 Construire les requêtes (sans les envoyer)

Les constructeurs de requêtes produisent des `RestconfDataRequest` /
`RestconfRpcRequest` avec `method`, `path` (URL-échappée), `headers`
(`Accept`/`Content-Type` `application/yang-data+json`) et `body?`. La
bibliothèque ne fait jamais de fetch pour vous : vous envoyez le request avec
votre client HTTP. Les chemins utilisent des segments de schéma
(`YangPathSegment { module, name, keys?, leafListValue? }`) ; le nom de module
ne répète que quand l'espace de noms change (RFC 8040 [§3.5.3]).

```ts
import {
  createRestconfGetRequest,
  createRestconfSetRequest,
  createRestconfAddRequest,
  createRestconfUpdateRequest,
  createRestconfDeleteRequest,
} from "yang-browser-engine";

const path = [
  { module: "acme-router", name: "interfaces" },
  { module: "acme-router", name: "interface", keys: [{ name: "name", value: "eth0" }] },
];

const read = createRestconfGetRequest(path);        // GET  /restconf/data/acme-router:interfaces/interface=eth0
const replace = createRestconfSetRequest(path, {    // PUT — remplace la ressource
  module: "acme-router",
  name: "interface",
  data: { name: "eth0", speed: 10000 },
});
const create = createRestconfAddRequest([{ module: "acme-router", name: "interfaces" }], {
  module: "acme-router",
  name: "interface",
  data: { name: "eth1", speed: 1000 },
});                                                  // POST — ajoute une entrée
const patch = createRestconfUpdateRequest(path, { module: "acme-router", name: "interface", data: { speed: 10000 } });
const remove = createRestconfDeleteRequest(path);    // DELETE

const send = (request) => fetch(request.path, {
  method: request.method,
  headers: request.headers,
  ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
});
```

Les paramètres de requête (RFC 8040 `content`, `depth`, `fields`, `filter`, …)
passent dans l'argument `query` optionnel de chaque constructeur.

Pour produire ces corps directement depuis vos valeurs de formulaire :
`formValuesToRestconfBody(model, values)` assemble le corps RFC 7951
module-qualifié (entiers 32 bits en nombres, 64 bits/`decimal64` en chaînes,
`empty` `[null]`, `bits` séparés par espaces, entrées de liste à partir de
tableaux d'enregistrements ordonnés), `formInputToRestconfBody(operation,
values)` l'objet d'entrée d'un RPC, et `formPathToYangPathSegments(path,
module, { listKeys, leafListValue })` traduit un `FormField.path` (marqueurs
`[*]`) en segments pour les constructeurs ci-dessus — refus explicite d'une
liste sans ses valeurs de clés. Les conventions d'encodage sont celles du §7
et le test d'aller-retour (`tests/forms-restconf.test.ts`) verrouille
l'équivalence avec `documentToYangJson`.

**NE PAS redéfinir les réponses ici**: lire une réponse se fait avec
`readRestconfData(response, module, name)`, qui extrait le membre
module-qualifié attendu d'un corps JSON :

```ts
import { readRestconfData } from "yang-browser-engine";

const interface2 = readRestconfData(await (await send(read)).json(), "acme-router", "interface");
interface2.speed;
```

### 8.4 RPC et datastore NMDA

Les `rpc` d'un module deviennent des `FormRpcOperation` dans le modèle de
formulaire (§5) ; `createRestconfRpcRequest` produit la requête POST RFC 8040
avec l'entrée enveloppée, et `readRestconfRpcOutput` déballe la sortie.
Côté NMDA (RFC 8527), les requêtes ciblent un datastore module-qualifié via
`createRestconfDatastoreRequest` / `nodeToRestconfDatastorePath`, et
`createRestconfNmdaProbeRequest` sonde la disponibilité du datastore
`operational` avec une simple requête `HEAD`.

```ts
import {
  createRestconfDatastoreRequest,
  createRestconfNmdaProbeRequest,
  createRestconfRpcRequest,
  nodeToRestconfDatastorePath,
  nodeToRestconfDataPath,
  nodeToXPath,
  readRestconfRpcOutput,
} from "yang-browser-engine";

const shutdown = model.operations.find((operation) => operation.name === "shutdown")!;
const rpcRequest = createRestconfRpcRequest(shutdown, { reason: "maintenance" });
// POST /restconf/operations/acme-router:shutdown  body { "acme-router:input": { reason: "maintenance" } }

const rpcResponse = await send(rpcRequest);         // à adapter : méthode, headers, body
const output = readRestconfRpcOutput(shutdown, await rpcResponse.json());
output?.status;

const operationalPath = nodeToRestconfDatastorePath("ietf-datastores:operational", path);
const probe = createRestconfNmdaProbeRequest();
const nmdatRequest = createRestconfDatastoreRequest("GET", "ietf-datastores:operational", path);

const xpath2 = nodeToXPath(root, path);             // /ar:interfaces/ar:interface[name='eth0'] (préfixes du module)
const restconfPath = nodeToRestconfDataPath(path);  // /restconf/data/…, identique à read.path
nodeToRestconfDataPath(path) === createRestconfGetRequest(path).path;
```

### 8.5 Le client RESTCONF (exécution des requêtes)

Les constructeurs produisent les requêtes ; `createRestconfClient` les
exécute avec un fetch injectable (aucun accès global à l'import), fusionne
les en-têtes (`Accept`/`Content-Type` du requête < en-têtes statiques ou
fournisseur dynamique < en-têtes d'appel) et retourne statut + lecture
d'en-têtes (`Location`, `ETag`, `Last-Modified`) + JSON paresseux
(`undefined` pour un 204). Toute réponse non-2xx lève une
`RestconfRequestError` typée : `status` plus, pour un corps RFC 8040 §7
`ietf-restconf:errors`, les champs `errorType`/`errorTag`/`errorPath` et la
liste `errorMessages` — y compris les conflits d'édition 409/412.

**Authentification (bonnes pratiques)** : le jeton reste dans un état
mémoire de l'application (jamais `localStorage`, jamais une variable
`NEXT_PUBLIC_*`) fourni par le callback `headers` ; les sessions à cookies
passent par `credentials: "include"`.

```ts
import { createRestconfClient, RestconfRequestError } from "yang-browser-engine";

const client = createRestconfClient({
  baseUrl: window.location.origin,
  headers: ({ method, path }) => ({ Authorization: `Bearer ${token}`, "X-Sent-For": `${method} ${path}` }),
  credentials: "include",
  signal: controller.signal,
});

const read = await client.send(createRestconfGetRequest(path));
const etag = read.headers.get("ETag");

try {
  await client.send(createRestconfSetRequest(
    path,
    { module: "acme-router", name: "interface", data: target },
  ), { headers: etag ? { "If-Match": etag } : {} });
} catch (error) {
  if (error instanceof RestconfRequestError) {
    console.error(error.status, error.errorTag, error.errorMessages);
  }
  throw error;
}
```

La navigation paginée (parcourir une grande liste via `depth`), la sonde NMDA
(`createRestconfNmdaProbeRequest`) et les tests correspondants vivent dans
`tests/restconf-client.test.ts`.

Deux filets de sécurité completes : `send(request, { timeoutMs })` coupe la
requête au délai (rejet `TimeoutError`, nouvelles tentatives idempotentes si
`retry` est activé) et `retry: { attempts, backoffMs }` (création du client)
rejoue GET/HEAD uniquement — sur erreur transport, délai dépassé ou 5xx, avec
attente exponentielle — jamais une annulation ni un 4xx, jamais POST/PUT/
PATCH/DELETE. Un `TypeError` navigateur (échec CORS/preflight opaque) devient
une `RestconfNetworkError` : le message porte la liste de contrôle CORS
(`Access-Control-Allow-Origin`, méthodes/en-têtes autorisés, réponse à
`OPTIONS`, URL/réseau) et l'erreur d'origine reste dans `cause`.

Reste ouvert (roadmap §204) : les flux de notification via `EventSource`.

## 9. Sécurité des sources non fiables

Le moteur parse du YANG **venu du réseau**. Trois lignes de défense :

1. **Budgets de résolution** (`resolveModuleSet` options `budget`) :
   `maxModules`, `maxSubmodules`, `maxDepth`, `maxSourceCharacters`,
   `deadlineMs` — déborder refuse tout chargement supplémentaire et produit un
   diagnostic (jamais un crash) ;
2. **Budget de compilation** (`compileYangModules` option `budget` →
   `budget: { maxSchemaNodes }`) plafonne la taille du schéma produit ;
3. **Annulation coopérative** partout : `signal` (AbortSignal) sur
   `resolveModuleSet`, `validateDataTree` et `evaluateCandidates`,
   deadlines (`deadlineMs`) sur validation et candidats.

Un snowball de statement (10Mo, imbrication extrême) ne mange donc ni CPU ni
mémoire au-delà des plafonds passés. Les constantes d'aide
`UNTRUSTED_MODULE_BUDGET` / `UNTRUSTED_SCHEMA_NODE_BUDGET` sont internes :
utilisez vos propres valeurs explicites.

## 10. Précompiler pour le navigateur (production)

En production le navigateur devrait charger un **artefact sérialisé** plutôt
que parser des sources YANG à chaque session. La CLI fournie écrit
`yang-schema.json` (schéma sérialisé versionné), `yang-modules/` (textes
source pour le fallback) et `yang-manifest.json` (inventaire nom/révision/
namespace/fichier).

```sh
npx yang-browser-engine precompile yang/*.yang --features acme-router:dual-stack --out dist/schema
```

Codes de sortie : `0` OK, `1` usage ou fichier manquant, `2` diagnostics YANG/
compilation. Sans `--features`, toutes les features restent disponibles.

Côté navigateur, désérialisez l'artefact : `deserializeCompiledSchema`
vérifie l'enveloppe (`format`, `version`, `structure`) lève une
`CompiledSchemaFormatError` avec l'un des codes `format`, `version`,
`structure` ou `unsupported-value` pour qu'une artefact périmé soit un écart
nommé, pas un crash cryptique. `serializeCompiledSchema(schema)` produit le
même format côté serveur/outil (clonage défensif : fonctions, DOM, symboles et
valeurs non finies sont des erreurs, pas des omissions) — parfait pour un
autolog en `localStorage`, cachez le prototypage suivant :

```ts
import { deserializeCompiledSchema, serializeCompiledSchema } from "yang-browser-engine";

const response = await fetch("/schema/yang-schema.json");
const schema = deserializeCompiledSchema(await response.json());
localStorage.setItem("yang-schema", JSON.stringify(serializeCompiledSchema(schema)));
const cached = deserializeCompiledSchema(JSON.parse(localStorage.getItem("yang-schema")!));
```

Pensez à auditer les révisions avec le serveur (§8.2) après chaque rechargement
de l'artefact.

## 11. Ce que le projet ne fait pas (et où chercher)

- **Pas de couche UI** : ni React hooks ni widgets — `createFormModel`
  produit des données neutres que votre UI consomme (§5) ;
- **Pas de transport** : les constructeurs RESTCONF ne fetchent pas ;
  `readRestconfData` ne décode que du JSON ;
- XPath : moteur compatible XPath 1.0 sur l'arbre accessible — l'intersection
  exacte est listée dans [CONFORMANCE.md](CONFORMANCE.md), interruption
  synchrone en attente (§35 de la roadmap) ;
- `deref()`, metadata annotations (`md:annotation`) et formes canoniques
  d'identités/iid ne sont pas implémentés ;
- L'exclusivité `case` des `choice` et le développement `uses`/`augment`
  niveau option ne sont pas couverts dans le modèle de formulaire (§5).

Autres ressources : [README.md](README.md) (aperçu et statut),
[docs/](docs/) (spécifications par composant), [examples/](examples/)
(`standalone.html`, `browser-usage.html` : HTML autonome, aucune commande, un
navigateur suffit), [ROADMAP.md](ROADMAP.md) (travail ouvert), et
`npx vitest run` pour la suite de tests complète (243 tests).
