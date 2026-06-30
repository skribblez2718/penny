# TypeScript Coding Best Practices

A human-readable guide to writing type-safe, maintainable, and robust TypeScript code.

## Core Philosophy

TypeScript is a **design surface**, not just a compiler. Your types are contracts — treat them with the same care as production APIs. When you write types well, the compiler catches bugs before they reach runtime, and your IDE provides accurate autocomplete and refactoring.

> "Types are more than syntax — they are contracts. Ship them with the same care as any production API."

## Strict Mode (Enable From Day One)

The single highest-impact change you can make:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true
  }
}
```

### What `strict: true` Gives You

- `strictNullChecks` — `null` and `undefined` are distinct types; you must handle them explicitly
- `noImplicitAny` — parameters without type annotations produce compile errors
- `strictFunctionTypes` — callback parameter types are checked correctly (catches subtle bugs)

### Why `noUncheckedIndexedAccess` Matters

Without it, `array[0]` returns type `T`. With it, it returns `T | undefined`, forcing you to handle the missing-element case:

```typescript
// Without noUncheckedIndexedAccess
const first = array[0]; // type: T (could be undefined at runtime!)

// With noUncheckedIndexedAccess
const first = array[0]; // type: T | undefined
if (first) {
  first.doSomething();
} // Safe
```

## `unknown` Over `any`

`any` disables type checking entirely. `unknown` forces you to prove what a value is before using it:

```typescript
// ❌ Dangerous — no type safety
function parse(data: any) {
  return data.user.name; // Could crash at runtime
}

// ✅ Safe — must narrow first
function parse(data: unknown) {
  if (typeof data === "object" && data !== null && "user" in data) {
    return (data as { user: { name: string } }).user.name;
  }
  throw new Error("Unexpected data shape");
}

// ✅ Best — validate with Zod
import { z } from "zod";
const Schema = z.object({ user: z.object({ name: z.string() }) });
const result = Schema.parse(data); // Throws with clear message if invalid
```

## Interfaces vs Type Aliases

When to use which:

| Use Case                            | Preferred   | Why                            |
| ----------------------------------- | ----------- | ------------------------------ |
| Object shapes that consumers extend | `interface` | Declaration merging support    |
| Public API contracts                | `interface` | Easier to extend for consumers |
| Unions, intersections, mapped types | `type`      | Interfaces can't express these |
| Function signatures, utility types  | `type`      | More flexible                  |

```typescript
// Interface for extendable shapes
interface User {
  id: string;
  name: string;
}

interface Admin extends User {
  permissions: string[];
}

// Type for unions and transformations
type Status = "active" | "inactive" | "pending";
type Result<T> = { ok: true; data: T } | { ok: false; error: Error };
```

## Discriminated Unions for State Modeling

Model data that can be in one of several states with different shapes:

```typescript
type ApiState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: User[] }
  | { status: 'error'; error: string };

function render(state: ApiState) {
  switch (state.status) {
    case 'idle': return <EmptyState />;
    case 'loading': return <Spinner />;
    case 'success': return <UserList users={state.data} />; // TypeScript knows data exists
    case 'error': return <ErrorMessage message={state.error} />;
  }
}
```

### Exhaustiveness Checking

Add a `never` check to guarantee all variants are handled:

```typescript
function assertNever(value: never): never {
  throw new Error(`Unhandled state: ${JSON.stringify(value)}`);
}

// In your switch:
default: return assertNever(state); // Compile error if you add a new state but forget to handle it
```

## Runtime Validation with Zod

TypeScript types disappear at compile time. Zod validates at runtime:

```typescript
import { z } from "zod";

// Define schema once
const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(["admin", "user", "viewer"]),
});

// Infer TypeScript type from schema
type User = z.infer<typeof UserSchema>;

// Validate at boundaries
function createUser(data: unknown) {
  const result = UserSchema.safeParse(data);
  if (!result.success) {
    console.error(result.error.flatten().fieldErrors);
    return null;
  }
  return result.data; // Fully typed and validated
}
```

### Zod Best Practices

- Use `safeParse()` by default (returns `{ success, data | error }`)
- Use `parse()` only when invalid data is truly exceptional
- Validate at system boundaries: API routes, form handlers, config loading
- Infer types from schemas — never maintain both separately
- Use `z.coerce.number()` for form data (HTML forms always submit strings)

## Type Guards

Write functions that narrow types for the compiler:

```typescript
function isUser(value: unknown): value is User {
  return typeof value === "object" && value !== null && "id" in value && "email" in value;
}

// Usage
if (isUser(maybeUser)) {
  console.log(maybeUser.email); // TypeScript knows this is User
}
```

## `satisfies` Operator

Validates a value against a type without widening — preserves literal types:

```typescript
const routes = {
  home: "/",
  about: "/about",
} satisfies Record<string, string>;

routes.home; // TypeScript suggests 'home' and other keys
routes.banana; // Error — key doesn't exist
```

## `as const` for Literal Types

Makes object/array properties readonly with literal types:

```typescript
const directions = ["north", "south", "east", "west"] as const;
type Direction = (typeof directions)[number]; // "north" | "south" | "east" | "west"
```

## Utility Types

TypeScript ships with powerful built-in types:

```typescript
interface User {
  id: string;
  name: string;
  email: string;
  password: string;
  createdAt: Date;
}

// Common patterns
type CreateUser = Omit<User, "id" | "createdAt">; // Exclude auto-generated fields
type UpdateUser = Partial<CreateUser>; // All fields optional
type PublicUser = Omit<User, "password">; // Never expose password
type UserSummary = Pick<User, "id" | "name">; // Select specific fields
```

## Error Handling

### Catch Variables Are `unknown`

```typescript
try {
  await save(data);
} catch (e: unknown) {
  if (e instanceof Error) {
    console.error(e.message); // Safe
  } else {
    console.error("Unexpected error:", e);
  }
}
```

### Always Throw `Error` Objects

```typescript
// Bad — no stack trace
throw "Something went wrong";

// Good — full stack trace
throw new Error("Something went wrong");
```

## Naming Conventions

| Category                          | Style          | Example       |
| --------------------------------- | -------------- | ------------- |
| Classes, interfaces, types, enums | UpperCamelCase | `UserService` |
| Variables, functions, methods     | lowerCamelCase | `fetchUser()` |
| Global constants, enum values     | CONSTANT_CASE  | `MAX_RETRIES` |

## Control Flow

- Always use braces, even for single statements
- Prefer `for (... of ...)` for arrays
- Avoid `for (... in ...)` on arrays (gives string indices, not values)
- Switch statements: must have `default`; non-empty cases must not fall through

## Type Assertions (`as`)

Avoid type assertions when possible. They tell the compiler "trust me" — but the runtime might disagree:

```typescript
// Bad — forces incorrect type
const user = {} as User; // TypeScript thinks this is User, but it's empty!

// Good — runtime check
if (typeof rawData === "object" && rawData !== null && "id" in rawData) {
  const user = rawData as User; // Safe after verification
}

// Best — Zod validation
const user = UserSchema.parse(rawData); // Throws if invalid, typed if valid
```

## Environment Validation

Validate environment variables at startup — fail fast with clear errors:

```typescript
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export const env = EnvSchema.parse(process.env);
// App crashes immediately with clear error if any env var is missing/invalid
```

### Extension Environment Variable Pattern

When writing Pi extensions, environment variables must be read inside the factory function, not at module scope. Pi loads extension modules sequentially, and the `environment` extension populates `process.env` from `.env` before other extensions run their factories. Module-level `process.env` reads capture stale or missing values.

**Incorrect:**
```typescript
const CONFIG = {
  url: process.env.MY_EXT_URL || "default", // Captured before .env is loaded
};
export default function (pi: ExtensionAPI) { /* CONFIG already locked */ }
```

**Correct:**
```typescript
interface MyConfig {
  url: string;
}
let config: MyConfig;
export default function (pi: ExtensionAPI) {
  config = {
    url: process.env.MY_EXT_URL || "default", // Sees .env values
  };
}
```

## Testing

### Framework: Vitest

Vitest is fast, Vite-native, and works seamlessly with TypeScript:

```typescript
// user.test.ts
import { describe, it, expect } from "vitest";
import { createUser } from "./user";

describe("createUser", () => {
  it("creates a user with valid data", () => {
    const user = createUser({ name: "Alice", email: "alice@example.com" });
    expect(user.name).toBe("Alice");
  });

  it("returns null for invalid email", () => {
    const user = createUser({ name: "Bob", email: "not-an-email" });
    expect(user).toBeNull();
  });
});
```

Run: `vitest run` or `vitest --watch`

## Dependency Management

**Always use `bun`** for package management in this project:

```bash
# Install a dependency
bun add zod

# Install a dev dependency
bun add -d vitest typescript @types/node

# Run a script
bun run build

# Run tests
bun vitest run
```

**Never use `npm` or `yarn`.** Bun is the project's standard package manager.

## Linting

ESLint with TypeScript support:

```bash
# Install
bun add -d eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin

# Run
bun eslint . --ext .ts,.tsx
```

Enable `@typescript-eslint/no-explicit-any` to catch `any` usage.

## Common Anti-Patterns

| Anti-Pattern                   | Why It's Bad                | Solution                       |
| ------------------------------ | --------------------------- | ------------------------------ |
| `any`                          | Disables all type checking  | `unknown` + narrowing or Zod   |
| Type assertions without checks | Runtime crashes possible    | `instanceof`, type guards, Zod |
| `parseInt` / `parseFloat`      | Ignores trailing characters | `Number()` + `isFinite` check  |
| `for (... in ...)` on arrays   | Gives string indices        | `for (... of ...)`             |
| Mutable global state           | Untestable, unpredictable   | Pure functions                 |

## Security Reminders

- Validate all external input with Zod at API boundaries
- Never trust client data — validate server-side too
- Use branded types for domain-specific IDs (prevents mixing up UserId and OrderId)
- For full security guidance, see the secure-coding documentation

## Further Reading

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Zod Documentation](https://zod.dev/)
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)
- [Total TypeScript](https://www.totaltypescript.com/) — Matt Pocock's advanced patterns
