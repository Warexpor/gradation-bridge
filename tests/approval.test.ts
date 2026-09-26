import { describe, expect, it } from "vitest";
import {
  decidePermission,
  requiresMachineWarning,
  type PermissionRequest,
} from "../src/approval/policy.js";

const root = "/home/user/project";
const allowed = [root];

function req(partial: Partial<PermissionRequest> & Pick<PermissionRequest, "kind">): PermissionRequest {
  return {
    workspaceRoot: root,
    allowedRoots: allowed,
    path: `${root}/src/main.ts`,
    ...partial,
  };
}

describe("approval policy: ask", () => {
  it("forwards every request", () => {
    for (const kind of ["edit", "execute", "read", "fetch"] as const) {
      const d = decidePermission("ask", req({ kind }));
      expect(d.action).toBe("ask");
    }
  });
});

describe("approval policy: auto-edit", () => {
  it("auto-allows edit inside workspace", () => {
    const d = decidePermission("auto-edit", req({ kind: "edit" }));
    expect(d).toEqual({ action: "allow", reason: expect.any(String) });
  });

  it("auto-allows write inside workspace", () => {
    const d = decidePermission("auto-edit", req({ kind: "write" }));
    expect(d.action).toBe("allow");
  });

  it("still asks for execute", () => {
    const d = decidePermission("auto-edit", req({ kind: "execute" }));
    expect(d.action).toBe("ask");
  });

  it("denies edit outside workspace", () => {
    const d = decidePermission(
      "auto-edit",
      req({ kind: "edit", path: "/etc/passwd" }),
    );
    expect(d.action).toBe("deny");
  });

  it("asks when edit has no path", () => {
    const d = decidePermission("auto-edit", req({ kind: "edit", path: undefined }));
    expect(d.action).toBe("ask");
  });
});

describe("approval policy: plan", () => {
  it("rejects writes", () => {
    expect(decidePermission("plan", req({ kind: "edit" })).action).toBe("deny");
    expect(decidePermission("plan", req({ kind: "write" })).action).toBe("deny");
  });

  it("rejects exec", () => {
    expect(decidePermission("plan", req({ kind: "execute" })).action).toBe("deny");
    expect(decidePermission("plan", req({ kind: "exec" })).action).toBe("deny");
  });

  it("allows reads", () => {
    expect(decidePermission("plan", req({ kind: "read" })).action).toBe("allow");
  });
});

describe("approval policy: full-auto", () => {
  it("allows all kinds inside workspace", () => {
    for (const kind of ["edit", "execute", "read", "fetch"] as const) {
      expect(decidePermission("full-auto", req({ kind })).action).toBe("allow");
    }
  });

  it("still denies paths outside sandbox", () => {
    const d = decidePermission(
      "full-auto",
      req({ kind: "edit", path: "/tmp/evil" }),
    );
    expect(d.action).toBe("deny");
  });

  it("requires a machine warning", () => {
    expect(requiresMachineWarning("full-auto")).toBe(true);
    expect(requiresMachineWarning("ask")).toBe(false);
  });
});
