# CAPE workflow pack

The CAPE pack configures the general Papyrus platform for business-operations modernization. It does not hard-code customer systems or claim production authorization.

## Demonstration path

1. An operator stages a PDF in Controlled Intake.
2. Papyrus records the original hash and runs durable native extraction; pages requiring OCR remain staged until an approved OCR adapter is available.
3. Deterministic inspection proposes CUI and privacy findings.
4. An authorized user confirms markings and releases the artifact.
5. A CAPE agent creates a bounded plan using a local Phi-4-mini endpoint.
6. LangGraph pauses before protected or external actions.
7. Stagehand works through a simulated enterprise adapter in the Browser session.
8. The reviewer approves the resulting coordination package.
9. Papyrus retains the artifact, processing provenance, event trace, evidence, and markings.

Document-processing limits, OCR enablement, languages, timeouts, and derivative retention are administered in the Papyrus UI. No YAML configuration is required.

The iCompass, DCPDS, DAI, and DISS adapters remain simulations until the customer provides authorized interfaces, test data, and connectivity.
