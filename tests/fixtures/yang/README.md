# YANG parser fixtures

These upstream models are retained as parser and module-graph fixtures, not as an assertion that semantic YANG compilation is implemented.

## Models and provenance

- `sysrepo/oven.yang`: the small oven model used by the Sysrepo plugin example, covering typedef/range, config and state data, defaults, RPC input/output, enumeration and notification. Source: [sysrepo/sysrepo](https://github.com/sysrepo/sysrepo/blob/master/examples/plugin/oven.yang).
- `standard/ietf/RFC/ietf-interfaces@2018-02-20.yang`: the requested RFC 8343 revision. Source: [YangModels/yang](https://github.com/YangModels/yang/blob/main/standard/ietf/RFC/ietf-interfaces%402018-02-20.yang).
- `standard/ietf/RFC/ietf-ip@2018-02-22.yang`: RFC 8344 IP model. It imports `ietf-interfaces`, `ietf-inet-types`, and `ietf-yang-types`, and augments both `/if:interfaces/if:interface` and the legacy `/if:interfaces-state/if:interface` tree.
- `standard/ietf/RFC/ietf-inet-types@2013-07-15.yang`: RFC 6991 common internet types.
- `standard/ietf/RFC/ietf-yang-types@2013-07-15.yang`: RFC 6991 common YANG types.
- `standard/ietf/draft/ietf-if-extensions@2025-08-07.yang`: the IETF NETMOD common interface extensions draft module. It has conditional nodes and augments driven by `if:type`.
- `standard/ietf/draft/ietf-if-ethernet-like@2025-08-07.yang`: the companion Ethernet-like interface module; its augments also use `if:type` predicates.
- `standard/iana/iana-if-type@2023-01-26.yang`: IANA interface identity definitions imported by both conditional extension modules.

The dependency closure for the augment example is therefore:

```text
ietf-interfaces@2018-02-20
└── ietf-yang-types@2013-07-15

ietf-ip@2018-02-22 (augmenting module)
├── ietf-interfaces@2018-02-20
├── ietf-inet-types@2013-07-15
└── ietf-yang-types@2013-07-15

ietf-if-extensions@2025-08-07 (IETF draft)
├── ietf-interfaces@2018-02-20
├── ietf-yang-types@2013-07-15
└── iana-if-type@2023-01-26
    └── ietf-interfaces

ietf-if-ethernet-like@2025-08-07 (IETF draft)
├── ietf-interfaces@2018-02-20
├── ietf-yang-types@2013-07-15
└── iana-if-type@2023-01-26
```

The tests assert that all these files parse, imports are represented, augment paths are retained, and the two extension modules contain `when` expressions that inspect `if:type`. Applying augments and evaluating those expressions against identities is a later milestone.
