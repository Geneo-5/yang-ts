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

Le paquet expose **deux points d'entrée** : la racine (`.`) pour le moteur, et
`yang-browser-engine/react` (§6) pour les bindings React (peer dependency
optionnelle). Les fichiers `.d.ts` sont
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
| Aides de formulaire | `createFormModel` | schéma compilé (ou `YangModule`) | champs typés, choices, opérations |

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
: passez toujours un budget en environnement non maîtrisé (voir §9).

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
modèles de données assemblés. Le format de chaque noeud est celui des types `CompiledSchemaNode`/`CompiledModule` déclarés dans
`src/yang/compiler.ts`. Deux raccourcis utiles : les chemins de
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

`createFormModel` construit les métadonnées de formulaire depuis un **schéma
compilé** (`CompiledYangSchema`) : champs (`FormField`), types d'origine YANG,
contraintes à évaluer, opérations `rpc` **et** `action`, structure
`choice`/`case`. Les `uses`, `augment` et `deviation` sont déjà appliqués par
le compilateur — le formulaire décrit le schéma développé complet. C'est un
modèle neutre, sans aucun DOM : la couche UI (React, Lit, …) reste à votre charge.

```ts
import { canonicalFormOf, compileYangModules, createFormModel, parseYang, resolveModuleSet, validateFormValue } from "yang-browser-engine";

const moduleSet = await resolveModuleSet([parseYang(source)], { loadModule });
const schema = compileYangModules(moduleSet, { enabledFeatures: new Set(["acme-router:turbo"]) });
const model = createFormModel(schema, { module: "acme-router" });
const field = model.fields.find((candidate) => candidate.path === "/interfaces/interface/speed")!;

const verdict = validateFormValue(field, "9000");
if (verdict.status !== "valid") {
  for (const problem of verdict.errors) console.error(`${problem.code}: ${problem.message}`);
}

const normalized = canonicalFormOf(field, "9000");
```

La compilation sans `enabledFeatures` considère chaque `feature` déclarée
comme disponible ; avec un ensemble explicite, les nœuds et les valeurs
`enum`/`bit` dont les `if-feature` ne sont pas satisfaits disparaissent du
formulaire (options filtrées, nœuds omis). `createFormModel(YangModule)`
reste accepté : le module est alors compilé à la volée avec les `options.modules`
fournis (fermeture d'imports complète attendue).

La structure **choix/cas** (RFC 7950 §7.9) est exposée dans `model.choices` :
au plus un `case` par `choice` est actif, donc une feuille `mandatory` d'un
case n'est exigée que lorsque son case est actif — ses champs portent
`casePath`/`caseName` (leur `required` reste `false`), et chaque `case`
recense ses feuilles obligatoires dans `requiredFieldPaths` pour l'UI ou le
validateur haut niveau. Les champs hors `choice` gardent leur `required`
habituel.

Enfin, `model.topModules` associe à chaque nœud racine son module de
déclaration : `formValuesToRestconfBody` qualifie chaque ressource top-level
avec le module approprié (multi-modules), et `model.operations` porte les
actions (`kind: "action"`, champs préfixés du chemin d'ancrage) autant que
les rpcs.

`validateFormValue` retourne aussi `pending` : la liste des contraintes
(`must`, `when`, `if-feature`) que le moteur ne peut pas évaluer à ce niveau —
l'UI doit les considérer comme **peut-être invalides**, pas valides. Enfin,
`canonicalFormOf(field, value)` normalise une saisie (booléen, décimal, bits…)
avant envoi.

**Limites connues (honnêteté)** : les notifications ne sont pas modélisées
(leur payload arrive par flux, pas par formulaire) ; les champs sous `case`
restent `pending` sur leurs vérifications croisées `leafref` s'ils sont
trouvés par chemin nu.

L'**API de binding** (roadmap Stage 8.4) assiste l'UI pour la sélection du
case actif et le ciblage d'une entrée de liste, alignée sur le contrat de
`formValuesToRestconfBody` (les entrées vivent à la liste `[*]`, chaque
enregistrement clé par les chemins complets des champs enfants) :

```ts
import { activeCaseFields, activeRequiredValues, listEntryFields, listEntryValues, withListEntry } from "yang-browser-engine";

const visible = activeCaseFields(model, new Map([["/conn/transport", "tls"]]));
const requiredNow = activeRequiredValues(model, new Map([["/conn/transport", "tls"]]));
const routeFields = listEntryFields(model, "/conn/routes/route[*]");
const row = listEntryValues(values, "/conn/routes/route[*]", 1);
const edited = withListEntry(values, "/conn/routes/route[*]", 1, { ...row, "/conn/routes/route[*]/target": "10.0.0.9" });
```

`activeCaseFields` retourne les champs hors choix + ceux du case actif ; un
choix ou un case inconnu est une erreur de binding signalée. La carte de
sélection accepte `undefined` (aucun case actif). `withListEntry` ne modifie
jamais la carte d'entrée (snapshot immuable).

## 6. React (`yang-browser-engine/react`)

Le sous-chemin `yang-browser-engine/react` fournit des hooks **headless** (roadmap Stage 8.4) : état sérialisable, sûr sous React strict mode et rendu
concurrent. React est une **peer dependency optionnelle** — le noyau du
moteur n'en dépend pas et les projets non-React n'installent rien.

```ts
import { YangProvider, useYangSchema, useFormModel, useFieldValidation } from "yang-browser-engine/react";
```

`YangProvider` initialise le moteur **dans un effet** (roadmap Stage 8.4) : le premier
rendu — serveur ou prérendu — montre un état `loading` et l'hydratation ne
diverge pas. Deux entrées possibles : `schema` déjà compilé (rendu `ready` dès
le premier rendu) ou une fabrique `compile: () => Promise<CompiledYangSchema>`
(effet au montage, résultats périmés ignorés, erreurs exposées en texte).

```ts
const app = createElement(YangProvider, { schema: compiledSchema },
  createElement(AppBody));
```

Les hooks: `useYangSchema()` (état loading/ready/error), `useFormModel(options?)`
(modèle de formulaire mémorisé du §5, `undefined` pendant le chargement),
`useFieldValidation(field, value)` (verdict par champ), `useDataValidation(document)`
(validation d'arbre complète), `useCandidates(document, path)` (candidats
contextuels du §4) et `useRestconfResource(client, path, { resource })` (GET
RFC 8040 avec donnees brutes JSON, état loading/ready/error, `refetch()`,
abandon à démontage). Le flux d'édition optimiste se documente en §6.2 ci-dessous.

## 6.1 Worker (roadmap Stage 8.4)

La validation et la compilation peuvent sortir du fil principal:
`createYangRunner({ worker, parseXml })` délègue à un module worker; sans
`worker`, le même gestionnaire tourne sur le fil appelant (réponses
identiques). Les schémas traversent la frontière en données pures (structured
clone) et le XML d'instance passe en texte, parsé par le parser de l'hôte.

```ts
import { createYangRunner, spawnYangWorker, YangTaskCancelledError } from "yang-browser-engine/react";

const runner = createYangRunner({ worker: spawnYangWorker(), parseXml: (text) => new DOMParser().parseFromString(text, "application/xml") });
const task = runner.compile([source1, source2], { enabledFeatures: ["acme-router:turbo"] });
const { schema, diagnostics } = await task; // plain data
task.cancel(); // → rejette avec YangTaskCancelledError
const verdict = await runner.validate(schema, instanceXml, { deadlineMs: 5000 });
```

`runner.validate/candidates/formModel` retournent des données sérialisables;
les tâches longues ne s'interrompent que là où le moteur vérifie les signaux
(visites de validation) — la limite XPath synchrone est documentée au Stage 7b P2 de la roadmap.

```ts
const model = useFormModel({ module: "acme-router" });
const field = model?.fields.at(0);
const verdict = useFieldValidation(field, "9000");
```

## 6.2 Édition optimiste (`useOptimisticEdit`, roadmap Stage 8.4)

Le flux d'édition enchaîne validation locale → décision → `PATCH`/`PUT` →
réconciliation serveur, chaque étape exposée en données pures :

```ts
import { useOptimisticEdit } from "yang-browser-engine/react";

const edit = useOptimisticEdit({
  model, client,
  resource: { module: "conf", name: "relay" },
  method: "PATCH",
});

const outcome = await edit.submit(values, { etag });
// outcome.kind: "blocked" | "done" | "failed" | "cancelled"
// edit.status : "idle" → "sending" → "blocked" | "done" | "failed"
```

Sémantique de fusion : une valeur **absente** de la carte signifie « non
touchée » — elle ne déclenche jamais d'erreur locale (seul le serveur sait ce
qui est déjà stocké) ; les entrées de liste sont validées entrée par entrée
avec le numéro attaché aux problèmes. Un verdict `invalid` bloque **avant** le fil avec
les raisons en clair ; un verdict `indeterminate` part sur le fil avec ses
raisons `pending.*` visibles — le serveur reste l'autorité — ou se bloque
explicitement via `onIndeterminate: "block"`. Le corps vient du contrat du §5
(`formValuesToRestconfBody`, y compris pour un leaf/leaf-list racine qui EST la
ressource), PATCH par défaut / PUT à la demande avec `If-Match` par soumission ;
les erreurs RFC 8040 §7 du serveur reviennent dans `outcome.server`
(`errorTag`, `errorPath`, `errorMessages`, `httpStatus`), l'`ETag` de réponse
dans `outcome.etag`, et un corps vide (aucune modification sous la sémantique
de fusion) bloque explicitement au lieu d'un envoi silencieux.

Pour `validateOptimisticValues(fields, values)` (vérification locale seule),
mêmes règles, sans envoi.

## 7. Arbre accessible et contraintes XPath

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

## 8. Adapter du JSON (RFC 7951) aux documents XML

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

## 9. RESTCONF : chargement de schéma, librairie et requêtes

### 9.1 Charger les modules depuis le serveur

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

### 9.2 Auditer les révisions (schéma embarqué vs serveur)

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

`SchemaRevisionMismatch.kind` vaut `only-in-schema`, `only-in-library` ou
`different-revision` (les deux révisions sont alors nommées) ; une
correspondance exacte ne produit aucune entrée, et les modules `import` du
serveur ne sont jamais signalés. Rejeter la session en cas d'écart évite de valider des données
contre un schéma que le serveur ne reconnait pas.

### 9.3 Construire les requêtes (sans les envoyer)

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
liste sans ses valeurs de clés. Les conventions d'encodage sont celles du §8
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

### 9.4 RPC et datastore NMDA

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

### 9.5 Le client RESTCONF (exécution des requêtes)

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

### 9.6 Flux de notification (`EventSource`, RFC 8040 §6)

`createRestconfNotificationStream` découvre l'URL du flux dans
`ietf-restconf-monitoring` (préfixe de module optionnel), s'abonne via l'
`EventSource` que l'hôte fournit (ou le global navigateur), livre chaque
message SSE brut à `onNotification` et gère les états `connecting → open`,
`reconnecting` (attente exponentielle plafonnée) et `closed`. `close()` — ou
l'annulation — ferme la source, supprime la reprise en attente et ignore les
messages tardifs ; le décodage du contenu de la notification reste dans
l'application (les payloads comme le XML de notification s'analysent avec le
`DOMParser` de l'hôte).

```ts
import { createRestconfNotificationStream } from "yang-browser-engine";

const stream = createRestconfNotificationStream({
  baseUrl: window.location.origin,
  encoding: "json",
  onNotification: ({ data }) => console.info("notification", data),
  onStateChange: (state) => void state,
  signal: controller.signal,
  reconnect: { delayMs: 500, maxDelayMs: 30_000 },
});

await stream.ready;        // inscrit ; l'échec de découverte rejette
stream.streamUrl;          // l'URL découverte
stream.close();            // libère l'EventSource ; idempotent
```

## 10. Sécurité des sources non fiables

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

## 11. Précompiler pour le navigateur (production)

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

Pensez à auditer les révisions avec le serveur (§9.2) après chaque rechargement
de l'artefact.

## 12. Ce que le projet ne fait pas (et où chercher)

- **Pas de couche UI** : ni React hooks ni widgets — `createFormModel`
  produit des données neutres que votre UI consomme (§5) ;
- **Pas de transport** : les constructeurs RESTCONF ne fetchent pas ;
  `readRestconfData` ne décode que du JSON ;
- XPath : moteur compatible XPath 1.0 sur l'arbre accessible — l'intersection
  exacte est listée dans [CONFORMANCE.md](CONFORMANCE.md), interruption
  synchrone impossible dans l'évaluateur tiers (limite documentée, Stage 7b P2) ;
- `deref()` suit les leafrefs et instance-identifiers sur l'arbre accessible ;
  `validateDataTree` vérifie les préfixes XML en portée et compare les noms
  d'étape et de prédicat par namespace et nom local. `require-instance false`
  garde ces contrôles lexicaux tout en ignorant l'existence de la cible.
  Les listes avec clés exigent toutes leurs clés, les listes sans clé une
  position et les leaf-lists une valeur. Une référence de configuration ne
  peut pas viser un nœud d'état. Les références entre racines de premier
  niveau fonctionnent dans une enveloppe datastore. Le schema-mount n'est pas
  pris en charge (voir [CONFORMANCE.md](CONFORMANCE.md)).
  Les annotations de métadonnées (`md:annotation`) ne sont pas évaluées.
  `identityref` et
  `instance-identifier` n'ont pas de forme canonique selon RFC 7950 §§9.10.4
  et 9.13.3 ; `canonicalFormOf` renvoie `undefined` pour ces types ;
- L'exclusivité `case` des `choice` et le développement `uses`/`augment`
  niveau option ne sont pas couverts dans le modèle de formulaire (§5).

Autres ressources : [README.md](README.md) (aperçu et statut),
[examples/](examples/)
(`standalone.html`, `browser-usage.html` : HTML autonome, aucune commande, un
navigateur suffit), [ROADMAP.md](ROADMAP.md) (travail ouvert), et
`npx vitest run` pour la suite de tests complète.
