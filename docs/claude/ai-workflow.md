# AI Workflow

Moved verbatim from `CLAUDE.md`. Paths are relative to the repository root.

## AI Collaboration and Development Workflow

### 1. Proportionate Design, Specification, and Review

- **Low-risk changes:** state intent and verify the focused result.
- **Normal changes:** before implementation, define the approach, behavior, edge cases, error handling, and acceptance criteria. Critically review material assumptions.
- **High-risk changes** (see Change Risk table): complete a written design and specification, identify trust boundaries and misuse cases, define invariants and recovery, and perform a critical review before coding. Resolve findings or record explicitly accepted residual risks. Approval MAY come from a human or, per the **Automated high-risk approval** policy above, from independent AI review under its compensating controls.

### 2. Contract-First Boundaries

Before implementing a new or changed API boundary:

1. Define or extend the Zod schema in `packages/shared/src/schemas/`.
2. Derive the TS types from it (`z.infer`) — server routes and web forms both consume the same contract.
3. Specify versioning, compatibility, errors, idempotency, limits, and ownership semantics as applicable.
4. Add contract or compatibility tests.

Internal behavior-preserving refactors do not require artificial contracts. The shared package is the single contract; it prevents hallucinated property names and keeps server and web in lockstep.

### 3. Contextual Markers

Use ordinary documentation first. These searchable markers MAY be used sparingly:

- `@ai-note`: a non-obvious invariant or business rule.
- `@ai-context`: a related spec section or implementation entry point.
- `@ai-warning`: a dangerous side effect, compatibility constraint, or legacy trap.

Markers must explain why; update or remove them when the code changes. Otherwise follow `docs/CONTRIBUTING.md`: no files that merely describe code; comments only for non-obvious "why".

### 4. Cohesive File Strategy

Layer-based server, file-based routes on web:

```
apps/server/src/
  ├── plugins/     # cross-cutting fastify-plugins: prisma, auth, auth-config, oidc,
  │                #   tenant-context, error-handler, login-state-signer
  ├── routes/      # thin HTTP handlers, one file per resource, registered under /api
  │                #   (health routes are unprefixed)
  ├── services/    # business logic classes taking PrismaClient (e.g. ClustersService)
  ├── crypto/ lib/ # secret-box (AES-GCM), date helpers
  └── __tests__/   # centralized integration tests + factories.ts + test-helpers.ts
apps/web/src/
  ├── routes/      # TanStack Router file-based routes (src/routeTree.gen.ts is generated)
  └── components/  # ui/ primitives + feature folders (overview/, clusters/, theme/)
packages/shared/src/schemas/   # Zod contracts shared by server + web
```

- Routes stay thin; business logic belongs in `services/`. Avoid both hyper-fragmentation and oversized modules with multiple independent reasons to change.

### 6. Prevent Hallucinations (Verify Before Use)

- **Dependencies and external APIs:** check the workspace `package.json`/lockfile before using a dependency, and verify the installed version and actual exported API — never invent packages, functions, options, or signatures.
- **Documentation lookup:** use the **Ref MCP server** first to search and read authoritative documentation instead of relying on model memory, especially for fast-moving majors used here (React 19, Vite 8, Tailwind 4, Fastify 5, Zod 4, Prisma 7, TanStack Router). Fall back to DeepWiki, then any other docs MCP, then the official upstream docs site. Record the source and version when it affects an implementation decision.
- **External research:** use **agy** for broad research, best-practice comparisons, and ecosystem surveys when available. Treat research as context, not authority — verify library/API claims through Ref.
- **Internal functions:** verify a utility, hook, endpoint, or service's existence and signature in the source before calling it.
