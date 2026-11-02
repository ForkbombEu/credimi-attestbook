AttestBook — Requirements & Implementation Specification
========================================================

**Repository:** `ForkbombEu/credimi-attestbook`  
**Product:** AttestBook  
**Primary integration:** Credimi  
**Architecture:** Standalone, reusable, API-first, standards-driven  
**Status:** Initial implementation specification

* * *

1\. Mission
===========

You are a senior software architect, EUDI Wallet standards engineer, and full-stack developer.

Your mission is to design and implement **AttestBook**, an open-source Attestation Rulebook registry, management, validation, and testing platform for the European Digital Identity Wallet ecosystem.

AttestBook must be an independently deployable and reusable product, not a module tightly coupled to Credimi.

Credimi will be its first major integration, but the architecture must allow other wallets, issuers, verifiers, Attestation Scheme Providers, public administrations, and interoperability testing platforms to use it independently.

AttestBook must support the complete lifecycle of Attestation Rulebooks:

*   Discovery and import
    
*   Authoring and editing
    
*   Schema and metadata management
    
*   Versioning and publication
    
*   Credential validation
    
*   Issuer and Verifier integration
    
*   Automated conformance testing
    
*   Evidence generation
    
*   Continuous interoperability testing integration
    

**Core principle:** An Attestation Rulebook must be an executable, testable specification, not merely a static collection of JSON documents.

The product must provide the foundations for continuous verification of credential structures and applicable attestation rules, while keeping protocol conformance and end-to-end interoperability as distinct testing dimensions.

* * *

2\. Mandatory technology requirement
====================================

2.1 Open Wallet Foundation dependency
-------------------------------------

The project MUST use:

`**@owf/eudi-attestation-schema**`

Repository:

[https://github.com/openwallet-foundation-labs/identity-common-ts](https://github.com/openwallet-foundation-labs/identity-common-ts)

This is a **hard architectural requirement**, not an optional dependency or merely a reference implementation.

The implementation MUST:

1.  Install and use the actual `@owf/eudi-attestation-schema` package.
    
2.  Inspect its exported interfaces, functions, types, supported standards and limitations.
    
3.  Reuse its existing capabilities for TS11 SchemaMeta handling, creation, signing and validation wherever applicable.
    
4.  Reuse its data models and validation primitives rather than implementing duplicate functionality.
    
5.  Build AttestBook-specific features around the library through a clearly defined adapter or service layer.
    
6.  Pin a tested dependency version and record compatibility.
    
7.  Include integration tests that execute the actual OWF package.
    
8.  Track upstream changes and assess compatibility with future ETSI standards.
    

**Do not replace this dependency with a custom implementation.**

If the library does not support a required operation, implement only the missing functionality in AttestBook, document the gap, and preserve interoperability with the OWF data models.

Do not assume the package provides features beyond its actual public API.

If the library's current API cannot satisfy a normative requirement, explicitly identify the incompatibility and propose an upstream contribution or a narrow extension. Do not silently bypass the mandatory dependency.

2.2 Technology selection
------------------------

Because the mandatory OWF dependency is TypeScript-based, AttestBook should be implemented primarily in TypeScript.

Preferred stack:

*   TypeScript with strict type checking
    
*   Bun for runtime and package management, subject to dependency compatibility
    
*   Existing OWF libraries for attestation schema operations
    
*   OpenAPI for public API contracts
    
*   JSON Schema for supported structural validation
    
*   A lightweight, maintainable HTTP framework
    
*   A persistence layer selected for portability and reproducibility
    
*   Docker for deployment
    
*   Automated CI and integration tests
    

Select the remaining technologies based on simplicity, maintainability and actual requirements.

Avoid unnecessary microservices, frameworks and infrastructure.

Do not introduce Go merely because Credimi uses Go. AttestBook must remain independently deployable and communicate with Credimi through stable APIs.

* * *

3\. Standards and normative references
======================================

Research the specifications before implementing their requirements.

3.1 EUDI Architecture and Reference Framework
---------------------------------------------

**EUDI ARF 3.0 — Section 5.5**

Attestation Rulebooks and Attestation Schemes:

[https://eudi.dev/3.0.0/main/05-data-model-and-data-exchange-protocols/#55-attestation-rulebooks-and-attestation-schemes](https://eudi.dev/3.0.0/main/05-data-model-and-data-exchange-protocols/#55-attestation-rulebooks-and-attestation-schemes)

AttestBook must follow the distinction between:

*   Attestation Rulebook
    
*   Attestation Scheme
    
*   Attestation Scheme Provider
    
*   Credential Issuer
    
*   Relying Party / Verifier
    
*   Wallet Provider
    
*   Trust infrastructure
    

Attestation Scheme Providers may include public administrations, sectoral organizations and cross-border organizations.

The European Commission maintains rulebooks for specific European identity attestations, including PID and mDL, but AttestBook must support rulebooks maintained by independent providers.

3.2 EC TS11
-----------

**EC TS11 v1.0.1 — January 2026**

Use TS11 as the initial implementation baseline.

Locate and inspect the authoritative technical specification, data models, JSON Schemas, OpenAPI definitions and available examples.

Implement its applicable interfaces and formats faithfully.

Maintain a traceability matrix linking implementation requirements to normative clauses.

3.3 ETSI EN 319 482-3
---------------------

Support future evolution toward:

**ETSI EN 319 482-3**

Research the stable draft v0.0.6 dated 27 October 2026 and compare it with EC TS11.

Identify:

*   Compatible data structures
    
*   Changed requirements
    
*   Additional metadata
    
*   Changed validation rules
    
*   Migration considerations
    
*   Potential API incompatibilities
    

Do not claim complete ETSI compliance before implementation and verification.

Design a version-aware standards adapter architecture.

3.4 Related standards
---------------------

Account for relevant requirements from:

*   OpenID4VCI
    
*   OpenID4VP
    
*   SD-JWT VC
    
*   ISO/IEC mdoc
    
*   JSON Schema
    
*   EUDI High Assurance Interoperability Profile, where applicable
    
*   Relevant trust and signature specifications
    

Do not conflate credential schema validation with protocol, cryptographic or trust validation.

* * *

4\. Product boundaries and architecture
=======================================

AttestBook must operate independently.

It must NOT require:

*   Credimi
    
*   Temporal
    
*   StepCI
    
*   PocketBase
    
*   A specific Wallet implementation
    
*   A specific Issuer implementation
    
*   A specific Verifier implementation
    

Instead, expose stable APIs and integration contracts.

4.1 Core logical modules
------------------------

### Registry

Stores rulebooks, providers, attestation types, metadata, schemas and versions.

### Standards Adapter

Implements standards-specific models and serialization using the mandatory OWF library.

### Catalog Importer

Imports external rulebooks and schema metadata.

### Rulebook Editor

Provides creation, modification, validation, preview and publication workflows.

### Validation Engine

Evaluates credential structures and relevant attestation constraints.

### Issuer Integration Adapter

Provides rulebook-driven test data and validation to external Issuer implementations.

### Verifier Integration Adapter

Provides rulebook constraints and validation capabilities to external Verifier implementations.

### Capture Integration Layer

Connects to capture-issuer and capture-verifier components, both current and future.

### Evidence and Reporting

Produces structured validation results suitable for automated testing, audit and debugging.

These are logical modules, not necessarily independent services.

* * *

5\. Rulebook registry
=====================

FR-001 — Rulebook management
----------------------------

The system MUST support multiple rulebooks from different Attestation Scheme Providers.

Each rulebook must contain, where applicable:

*   Stable identifier
    
*   Name
    
*   Description
    
*   Provider identity
    
*   Source URL
    
*   Provenance
    
*   Version
    
*   Publication status
    
*   Applicable specification/profile
    
*   Supported attestation types
    
*   Referenced schemas
    
*   Metadata
    
*   Publication timestamps
    
*   Content digest
    

Distinguish normative TS11 fields from AttestBook-specific internal metadata.

Never inject proprietary metadata into a standards-defined document in a way that breaks interoperability.

FR-002 — Versioning
-------------------

Support:

*   Draft versions
    
*   Published versions
    
*   Historical versions
    
*   Version comparison
    
*   Immutable published artifacts
    
*   Version-specific validation
    
*   Content digest verification
    

Published versions must remain reproducible.

A test execution must reference the exact rulebook version and digest used.

FR-003 — Provider management
----------------------------

Support multiple Attestation Scheme Providers.

A provider may own and maintain multiple rulebooks.

Implement appropriate ownership and authorization mechanisms.

Provider identity and publication authority must not be inferred solely from a remote URL.

* * *

6\. Catalog discovery and import
================================

FR-004 — External rulebook import
---------------------------------

Implement an adapter-based import system.

Investigate existing implementations and catalogs including:

*   SIROS
    
*   EUDIPLO
    
*   FIDES
    
*   EUDI Reference Implementation
    
*   Sphereon
    

Identify their actual interfaces and data formats.

Support:

*   URL-based import
    
*   JSON file import
    
*   Standards-compliant catalog discovery
    
*   Import preview
    
*   Structural validation
    
*   Compatibility reporting
    
*   Version conflict detection
    
*   Provenance preservation
    
*   Safe re-import
    

Do not assume every catalog fully implements TS11.

FR-005 — Catalog synchronization
--------------------------------

Allow remote catalogs to be synchronized periodically.

Requirements:

*   Conditional fetching where supported
    
*   Idempotent imports
    
*   Change detection
    
*   Conflict reporting
    
*   Version preservation
    
*   Source availability diagnostics
    

Never silently overwrite locally edited or published rulebooks.

FR-006 — Issuer metadata discovery
----------------------------------

Given an OpenID4VCI Credential Issuer URL, AttestBook should:

1.  Discover credential issuer metadata.
    
2.  Extract supported credential configurations.
    
3.  Identify credential formats and type identifiers.
    
4.  Identify exposed schema references.
    
5.  Attempt to associate configurations with known rulebooks.
    
6.  Report unmatched and ambiguous configurations.
    
7.  Allow explicit manual mapping.
    

Issuer metadata must not be treated as an authoritative substitute for an Attestation Rulebook.

* * *

7\. Rulebook editor and publication
===================================

FR-007 — Rulebook editor
------------------------

Provide a web UI supporting:

*   Rulebook creation
    
*   Attestation type management
    
*   Schema editing
    
*   Metadata editing
    
*   JSON preview
    
*   Validation diagnostics
    
*   Version comparison
    
*   Draft management
    
*   Publication
    
*   Export
    

Use the OWF library for supported metadata operations.

Provide a developer-friendly JSON editor with validation feedback.

FR-008 — Publication
--------------------

Allow authorized providers to publish validated rulebooks.

Published artifacts must be:

*   Stable
    
*   Versioned
    
*   Retrievable
    
*   Exportable
    
*   Reproducible
    
*   Associated with provenance and integrity metadata
    

Where the standard defines signing or verification operations, use the mandatory OWF library.

Do not invent proprietary signing semantics as a substitute for normative ones.

* * *

8\. Credential validation engine
================================

FR-009 — Validation API
-----------------------

Expose a reusable validation API.

Inputs:

*   Credential artifact or parsed credential
    
*   Rulebook identifier
    
*   Rulebook version
    
*   Attestation type
    
*   Validation options
    

Outputs:

*   Overall validation result
    
*   Rulebook and schema references
    
*   Rulebook version and digest
    
*   Validation dimensions
    
*   Structured violations
    
*   Attribute paths
    
*   Expected constraints
    
*   Actual values where safe
    
*   Severity
    
*   Human-readable diagnostics
    
*   Machine-readable evidence
    

FR-010 — Validation dimensions
------------------------------

Keep the following dimensions separate:

1.  Credential parsing
    
2.  Credential format recognition
    
3.  Cryptographic verification
    
4.  Schema validation
    
5.  Attestation-specific constraints
    
6.  Issuer and trust-policy validation
    
7.  Protocol conformance
    
8.  End-to-end interoperability
    

AttestBook's core validation engine is responsible for supported structural and attestation-specific checks.

Other dimensions may be supplied by external adapters or test orchestration systems.

Never claim a dimension has passed if it was not executed.

FR-011 — Credential format support
----------------------------------

Prioritize SD-JWT VC.

Design extensible interfaces for:

*   mdoc/mDL
    
*   Other supported credential formats
    

Use actual parsers and validation libraries.

Do not claim mdoc support merely because a generic JSON Schema validator exists.

FR-012 — Validation results
---------------------------

Support:

*   PASS
    
*   FAIL
    
*   NOT\_TESTED
    
*   NOT\_APPLICABLE
    
*   INCONCLUSIVE
    

A credential that matches a JSON Schema but has an invalid signature must not be reported as fully valid.

A credential that passes all local checks must not automatically be reported as interoperable with real wallets.

* * *

9\. Rulebook-driven Issuer integration
======================================

FR-013 — Issuer test fixtures
-----------------------------

AttestBook must expose capabilities allowing external Issuers to generate credentials based on a selected rulebook.

A client should be able to:

1.  Select a rulebook.
    
2.  Select an attestation type.
    
3.  Select a rulebook version.
    
4.  Obtain relevant attribute definitions.
    
5.  Generate a structurally valid test payload.
    
6.  Override selected test attributes.
    
7.  Generate negative test cases.
    
8.  Validate the resulting credential.
    

AttestBook does not need to become a full production Credential Issuer.

Credential signing and issuance protocols may remain responsibilities of external Issuer implementations.

Clearly distinguish unsigned test payloads from genuinely issued credentials.

* * *

10\. Rulebook-driven Verifier integration
=========================================

FR-014 — Verifier test fixtures
-------------------------------

External Verifiers must be able to consume AttestBook rulebook definitions.

Capabilities should include:

*   Resolving attestation types
    
*   Inspecting attribute constraints
    
*   Retrieving schema definitions
    
*   Building compatible validation policies
    
*   Validating credential data
    
*   Reporting violations
    
*   Generating negative verification test cases
    

Where presentation request generation is supported, use actual OpenID4VP requirements.

Do not assume a JSON Schema can automatically produce a complete valid presentation request.

* * *

11\. Future capture-issuer and capture-verifier integration
===========================================================

**This is a first-class architectural requirement, even if full implementation is deferred.**

AttestBook must be designed from the beginning to integrate with the emerging Credimi capture components:

*   `capture-issuer`
    
*   `capture-verifier`
    

These integrations must not require major architectural rewrites.

11.1 Capture integration concept
--------------------------------

Capture components are intended to provide observable evidence of real credential issuance and verification interactions.

AttestBook must be able to consume captured artifacts and evaluate them against applicable rulebook requirements.

The capture layer and the validation layer must remain independent.

AttestBook must not assume capture components are responsible for issuing or verifying credentials themselves.

Their precise runtime responsibilities and transport interfaces must be discovered from their actual implementations or documented contracts.

FR-015 — Capture artifact model
-------------------------------

Define a normalized capture artifact envelope.

Candidate fields:

*   Capture identifier
    
*   Correlation identifier
    
*   Source component
    
*   Capture timestamp
    
*   Interaction type
    
*   Protocol
    
*   Credential format
    
*   Artifact type
    
*   Artifact reference
    
*   Associated issuer or verifier
    
*   Associated test execution
    
*   Metadata
    
*   Redaction status
    
*   Integrity metadata
    

This is an internal proposed contract, not a TS11 normative structure.

Separate sensitive raw artifacts from metadata.

Support secure references to externally stored artifacts instead of requiring credential contents to be embedded in every event.

FR-016 — capture-issuer integration
-----------------------------------

AttestBook must eventually consume issuance evidence from `capture-issuer`.

Example workflow:

1.  A Wallet interacts with an Issuer.
    
2.  capture-issuer records relevant issuance interactions.
    
3.  The capture system produces structured evidence.
    
4.  AttestBook receives or retrieves an authorized capture artifact.
    
5.  AttestBook identifies the credential format and attestation type.
    
6.  AttestBook resolves the relevant rulebook.
    
7.  The validation engine checks the credential against the selected requirements.
    
8.  AttestBook produces structured findings.
    
9.  Credimi correlates those findings with the original issuance test.
    

Potential captured evidence includes:

*   Credential issuer metadata
    
*   Credential configuration identifiers
    
*   Credential offer information
    
*   Relevant protocol messages
    
*   Issued credential artifacts
    
*   Error responses
    
*   Relevant execution metadata
    

Only collect information actually available and authorized.

Support redaction and avoid unnecessary retention of personal data or secrets.

FR-017 — capture-verifier integration
-------------------------------------

AttestBook must eventually consume verification evidence from `capture-verifier`.

Example workflow:

1.  A Wallet interacts with a Verifier.
    
2.  capture-verifier records relevant presentation interactions.
    
3.  Captured evidence is normalized.
    
4.  AttestBook resolves applicable attestation rules.
    
5.  The engine evaluates relevant credential attributes and constraints.
    
6.  AttestBook produces structured validation findings.
    
7.  Credimi correlates those findings with presentation protocol and interoperability results.
    

Potential evidence includes:

*   Presentation request metadata
    
*   Requested credential types
    
*   Attribute constraints
    
*   Presentation submission metadata
    
*   Presented credential artifacts
    
*   Verification outcomes
    
*   Error responses
    

Do not assume captured presentation data always exposes all credential claims.

Account for selective disclosure, encrypted artifacts and privacy constraints.

FR-018 — Capture integration contracts
--------------------------------------

Design explicit interfaces such as:

*   `CaptureArtifact`
    
*   `CaptureSource`
    
*   `CaptureImporter`
    
*   `CaptureNormalizer`
    
*   `CaptureValidationRequest`
    
*   `CaptureValidationResult`
    

These are suggested logical contracts, not mandatory exact type names.

Support both:

*   Pull-based capture retrieval
    
*   Push-based artifact submission
    

Implement an adapter interface so transport-specific integration can be added later.

Provide a mock capture adapter for integration testing.

Do not introduce an event broker solely for hypothetical future requirements.

FR-019 — Correlation and traceability
-------------------------------------

AttestBook must support correlation among:

*   Rulebook version
    
*   Credential artifact
    
*   Issuance interaction
    
*   Verification interaction
    
*   Capture source
    
*   Credimi test execution
    
*   Validation results
    

Correlation must work without requiring AttestBook to own the entire test orchestration lifecycle.

Use stable identifiers and explicit references.

* * *

12\. Credimi integration
========================

Credimi is the primary external consumer of AttestBook.

The integration must remain API-driven.

FR-020 — Credimi test orchestration
-----------------------------------

Credimi should be able to:

*   List available rulebooks
    
*   Select an attestation type
    
*   Pin a rulebook version
    
*   Request credential validation
    
*   Retrieve structured results
    
*   Associate results with test executions
    
*   Display rulebook conformance evidence
    
*   Compare rulebook results with protocol tests
    

AttestBook must not directly depend on Temporal, StepCI or PocketBase.

Credimi may implement an adapter using its existing infrastructure.

FR-021 — Headless Wallet testing
--------------------------------

Support the following future workflow:

1.  Credimi starts an Issuer interoperability test.
    
2.  Wallet A obtains a credential from Issuer B.
    
3.  A Headless Wallet independently obtains a credential from Issuer B.
    
4.  The issued credential is submitted to AttestBook.
    
5.  AttestBook validates it against a pinned rulebook.
    
6.  Credimi compares the results with observed Wallet A behavior.
    
7.  Credimi reports structural, protocol and interoperability failures separately.
    

AttestBook should provide validation services and evidence, not implement a second orchestration platform.

The Headless Wallet may use Credo.ts or another suitable implementation.

Do not add a Headless Wallet runtime inside AttestBook unless there is a compelling architectural reason.

FR-022 — Continuous conformance
-------------------------------

Credimi must eventually be able to run recurring rulebook conformance checks.

AttestBook must support reproducible, deterministic validation suitable for automated execution.

Provide machine-readable outputs, stable error classifications and explicit version references.

* * *

13\. Public API
===============

Design a documented REST API with OpenAPI definitions.

Suggested resource groups:

*   `GET /api/rulebooks`
    
*   `POST /api/rulebooks`    
*   `GET /api/rulebooks/{id}`
    
*   `GET /api/rulebooks/{id}/versions`
    
*   `GET /api/rulebooks/{id}/attestations`
    
*   `POST /api/rulebooks/import`
    
*   `POST /api/rulebooks/{id}/publish`
    
*   `POST /api/credentials/validate`
    
*   `POST /api/issuers/discover`
    
*   `POST /api/captures/validate`
    
*   `GET /api/validations/{id}`
    

These are proposed product APIs, not normative TS11 endpoints.

Implement TS11-required interfaces separately and exactly where applicable.

Requirements:

*   Typed requests and responses
    
*   Input validation
    
*   Consistent errors
    
*   OpenAPI documentation
    
*   Authentication and authorization
    
*   API versioning strategy
    
*   Idempotency where appropriate
    
*   Clear distinction between synchronous and asynchronous operations
    

* * *

14\. User interface
===================

Provide a standalone web interface.

UI-001 — Rulebook catalog
-------------------------

Display:

*   Rulebook name
    
*   Provider
    
*   Version
    
*   Status
    
*   Supported attestation types
    
*   Source
    
*   Last synchronization
    
*   Validation/compatibility status
    

Support search and filtering.

UI-002 — Rulebook details
-------------------------

Show:

*   Provider information
    
*   Rulebook metadata
    
*   Attestation types
    
*   Schema references
    
*   Standards compatibility
    
*   Version history
    
*   Source provenance
    
*   Export actions
    

UI-003 — Rulebook editor
------------------------

Provide:

*   JSON editing
    
*   Metadata editing
    
*   Live validation
    
*   Schema inspection
    
*   Version diff
    
*   Draft management
    
*   Publication
    

UI-004 — Import interface
-------------------------

Support:

*   Import from URL
    
*   Import from file
    
*   Preview
    
*   Compatibility diagnostics
    
*   Conflict resolution
    
*   Synchronization settings
    

UI-005 — Credential playground
------------------------------

A developer must be able to:

1.  Paste or upload a credential.
    
2.  Select a rulebook.
    
3.  Select an attestation type.
    
4.  Run validation.
    
5.  Inspect individual violations.
    
6.  Export the result.
    

Clearly indicate which validation dimensions were executed.

UI-006 — Capture explorer
-------------------------

Design the interface for future capture integration.

It should eventually display:

*   Capture source
    
*   Protocol interaction
    
*   Credential artifacts
    
*   Rulebook association
    
*   Validation findings
    
*   Correlated test execution
    
*   Evidence timeline
    

Do not implement a fake production capture integration.

A mock-backed interface is acceptable during initial development if clearly identified as such.

* * *

15\. Security requirements
==========================

Treat imported catalogs, schemas, credentials and capture artifacts as untrusted input.

Mandatory controls:

*   SSRF protection for remote imports
    
*   Safe URL validation
    
*   Network timeouts
    
*   Response size limits
    
*   JSON parsing limits
    
*   JSON Schema reference controls
    
*   Resource consumption limits
    
*   Safe handling of recursive references
    
*   Authentication and authorization
    
*   Provider ownership enforcement
    
*   Secret redaction
    
*   Personal data minimization
    
*   Secure artifact storage
    
*   Audit logging for publication operations
    

Capture artifacts may contain sensitive credential data.

Do not log raw credentials, tokens, private keys or personal attributes by default.

Never execute code embedded in imported documents.

Do not automatically trust remote schemas or their providers.

* * *

16\. Testing requirements
=========================

Implement unit, integration and end-to-end tests.

Standards tests
---------------

*   Valid TS11 metadata
    
*   Invalid TS11 metadata
    
*   Missing required fields
    
*   Unsupported metadata versions
    
*   Schema reference handling
    
*   Version compatibility
    
*   OWF package integration
    

Registry tests
--------------

*   Rulebook creation
    
*   Import
    
*   Duplicate detection
    
*   Versioning
    
*   Publication
    
*   Immutable published artifacts
    
*   Provider ownership
    

Validation tests
----------------

*   Valid credential
    
*   Missing attributes
    
*   Incorrect attribute types
    
*   Unsupported formats
    
*   Invalid signatures
    
*   Ambiguous schema association
    
*   Rulebook version mismatch
    
*   Invalid external references
    

Capture tests
-------------

*   Valid capture artifact
    
*   Missing artifact
    
*   Malformed artifact
    
*   Redacted artifact
    
*   Unsupported protocol
    
*   Correlation identifiers
    
*   Mock capture-issuer input
    
*   Mock capture-verifier input
    

Integration tests
-----------------

*   API contract tests
    
*   UI workflows
    
*   Database migrations
    
*   Docker startup
    
*   OWF dependency compatibility
    
*   OpenAPI contract validation
    

Negative tests must explicitly demonstrate that:

*   Schema validity does not imply cryptographic validity.
    
*   Cryptographic validity does not imply trust.
    
*   Rulebook conformance does not imply protocol conformance.
    
*   Protocol conformance does not imply successful interoperability.
    

* * *

17\. Non-functional requirements
================================

Reliability
-----------

*   Deterministic validation
    
*   Reproducible results
    
*   Pinned rulebook versions
    
*   Graceful handling of unavailable catalogs
    
*   Idempotent imports
    
*   Clear error classifications
    

Performance
-----------

*   Efficient schema validation
    
*   Caching of immutable published rulebooks
    
*   Configurable resource limits
    
*   Avoid repeated remote retrieval during validation
    
*   Suitable for continuous automated testing
    

Portability
-----------

*   Docker deployment
    
*   Documented configuration
    
*   No mandatory external cloud services
    
*   Simple local development
    
*   Support for standalone installations
    

Maintainability
---------------

*   Strict TypeScript
    
*   Modular architecture
    
*   Stable public contracts
    
*   Minimal dependencies
    
*   Comprehensive tests
    
*   Generated OpenAPI documentation
    
*   Clear separation of standards logic and product logic
    

* * *

18\. Implementation phases
==========================

Phase 0 — Research and architecture
-----------------------------------

Before implementation:

1.  Inspect the OWF repository and package.
    
2.  Verify the actual package API.
    
3.  Study EC TS11 v1.0.1.
    
4.  Study ETSI EN 319 482-3 draft differences.
    
5.  Research existing rulebook implementations.
    
6.  Identify reusable libraries.
    
7.  Define AttestBook's architecture.
    
8.  Define capture integration contracts.
    
9.  Define the initial database model.
    
10.  Create a standards traceability matrix.
     

Deliver:

*   `docs/architecture.md`
    
*   `docs/standards.md`
    
*   `docs/requirements.md`
    
*   `docs/capture-integration.md`
    
*   `docs/implementation-plan.md`
    

Include explicit decisions, assumptions and unresolved questions.

Phase 1 — Core MVP
------------------

Implement:

*   Project scaffolding
    
*   Mandatory OWF dependency
    
*   Persistence
    
*   Rulebook registry
    
*   TS11-compatible metadata handling
    
*   External import
    
*   Rulebook catalog UI
    
*   Rulebook detail UI
    
*   Credential validation engine
    
*   Validation playground
    
*   REST API
    
*   OpenAPI documentation
    
*   Automated tests
    
*   Docker deployment
    

**Phase 1 must produce a genuinely working standalone application.**

Phase 2 — Authoring and publication
-----------------------------------

Implement:

*   Rulebook editor
    
*   Draft lifecycle
    
*   Version comparison
    
*   Publication workflow
    
*   Provider management
    
*   Signing/integrity operations where supported
    
*   Export
    

Phase 3 — Issuer and Verifier integration
-----------------------------------------

Implement:

*   Issuer discovery
    
*   Credential configuration mapping
    
*   Rulebook-driven test fixtures
    
*   Negative test generation
    
*   Verifier validation policies
    
*   External integration examples
    

Phase 4 — Capture integration
-----------------------------

Implement:

*   Capture artifact model
    
*   Capture import API
    
*   Capture normalization
    
*   Mock capture-issuer adapter
    
*   Mock capture-verifier adapter
    
*   Capture explorer
    
*   Capture-based validation
    
*   Correlation and evidence reporting
    

Then integrate actual capture components when their contracts are available.

Phase 5 — Credimi integration
-----------------------------

Implement:

*   Credimi API client or adapter
    
*   Rulebook selection in test configurations
    
*   Headless Wallet validation workflow
    
*   Evidence correlation
    
*   Continuous conformance integration
    
*   Reporting integration
    

Phase 6 — Hardening and standards evolution
-------------------------------------------

Implement:

*   Security audit
    
*   Performance testing
    
*   Compatibility tests
    
*   ETSI migration support
    
*   Documentation improvements
    
*   Interoperability testing against external implementations
    

* * *

19\. Acceptance criteria
========================

The project is successful when:

**AC-01:** AttestBook runs independently from Credimi.

**AC-02:** The actual `@owf/eudi-attestation-schema` package is installed, used and covered by integration tests.

**AC-03:** Supported TS11 rulebooks can be imported and inspected.

**AC-04:** Rulebook metadata can be managed and exported without losing required normative information.

**AC-05:** Rulebooks support reproducible versioning.

**AC-06:** Published versions are immutable.

**AC-07:** A user can validate a credential against a selected rulebook version.

**AC-08:** Validation errors identify the applicable constraints and failing attributes.

**AC-09:** A user can create, edit and publish a supported rulebook.

**AC-10:** An Issuer can consume AttestBook definitions through a documented API.

**AC-11:** A Verifier can consume AttestBook constraints through a documented API.

**AC-12:** The architecture supports capture-issuer and capture-verifier without redesigning the validation engine.

**AC-13:** Mock capture artifacts can be validated through the public API.

**AC-14:** Capture evidence can be correlated with validation results.

**AC-15:** Credimi can consume AttestBook results without direct database access.

**AC-16:** Rulebook, cryptographic, protocol and interoperability results remain distinguishable.

**AC-17:** Unsupported functionality is explicitly reported rather than silently treated as passing.

**AC-18:** The application includes automated tests, Docker configuration and developer documentation.

* * *

20\. Development execution instructions
=======================================

Start by researching the standards and inspecting the mandatory OWF dependency.

Do not start by inventing new data models that duplicate TS11 or the OWF package.

Produce a concise architecture and implementation plan.

Then implement Phase 1 as a complete working vertical slice.

Follow these rules:

1.  Prefer existing standards and libraries over custom implementations.
    
2.  Keep AttestBook independently deployable.
    
3.  Treat OWF integration as mandatory.
    
4.  Keep Credimi integration API-driven.
    
5.  Design capture-issuer and capture-verifier integration contracts from the beginning.
    
6.  Avoid speculative infrastructure and premature microservices.
    
7.  Do not claim standards compliance without test evidence.
    
8.  Use real validation logic, not placeholder success responses.
    
9.  Write automated tests alongside implementation.
    
10.  Run formatting, linting, type checking and tests.
     
11.  Do not deploy to production or push commits without explicit approval.
     
12.  Record unsupported features and unresolved standards questions.
     

At the end of each implementation phase, report:

*   Implemented features
    
*   Standards and versions supported
    
*   OWF package functionality reused
    
*   APIs added
    
*   UI screens added
    
*   Tests executed and results
    
*   Known limitations
    
*   Remaining integration work
    
*   Recommended next phase
    

* * *

21\. Product vision
===================

AttestBook should become the reusable open-source foundation for **executable Attestation Rulebooks** in the EUDI ecosystem.

Its long-term purpose is to connect four previously separate concerns:

**Attestation Schemes**  
What a credential is required to represent.

**Credential Implementations**  
What Issuers actually produce and Verifiers actually accept.

**Capture and Observability**  
What happens during real issuance and presentation interactions.

**Continuous Conformance**  
Whether implementations continue satisfying their requirements over time.

AttestBook defines, manages and evaluates attestation requirements.

capture-issuer and capture-verifier provide observable evidence from real interactions.

Credimi orchestrates continuous testing and correlates results across wallets, issuers and verifiers.

Together, these components can provide an evidence-driven interoperability and conformance testing infrastructure.

**The objective is not another JSON Schema registry. It is to turn Attestation Rulebooks into executable, reusable and continuously testable interoperability contracts.**