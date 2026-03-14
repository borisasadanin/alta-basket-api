import { describe, it, expect, beforeEach } from "vitest";
import {
  createViewerToken,
  createAdminToken,
  isValidViewerToken,
  isValidAdminToken,
  viewerTokens,
  adminTokens,
} from "../auth.js";

describe("auth token management", () => {
  beforeEach(() => {
    viewerTokens.clear();
    adminTokens.clear();
  });

  describe("createViewerToken / isValidViewerToken", () => {
    it("creates a valid UUID-format token", () => {
      const token = createViewerToken();
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
    });

    it("stores the token in the viewerTokens map", () => {
      const token = createViewerToken();
      expect(viewerTokens.has(token)).toBe(true);
    });

    it("validates a freshly created token", () => {
      const token = createViewerToken();
      expect(isValidViewerToken(token)).toBe(true);
    });

    it("rejects an unknown token", () => {
      expect(isValidViewerToken("not-a-real-token")).toBe(false);
    });

    it("rejects an expired token", () => {
      const token = createViewerToken();
      // Force-expire by setting timestamp in the past
      viewerTokens.set(token, Date.now() - 1000);
      expect(isValidViewerToken(token)).toBe(false);
      // Token should be cleaned up after failed validation
      expect(viewerTokens.has(token)).toBe(false);
    });
  });

  describe("createAdminToken / isValidAdminToken", () => {
    it("creates a valid token", () => {
      const token = createAdminToken();
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
    });

    it("validates a freshly created token", () => {
      const token = createAdminToken();
      expect(isValidAdminToken(token)).toBe(true);
    });

    it("rejects an unknown token", () => {
      expect(isValidAdminToken("fake-admin-token")).toBe(false);
    });

    it("rejects an expired token", () => {
      const token = createAdminToken();
      adminTokens.set(token, Date.now() - 1000);
      expect(isValidAdminToken(token)).toBe(false);
      expect(adminTokens.has(token)).toBe(false);
    });
  });

  describe("token uniqueness", () => {
    it("creates unique tokens each time", () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 50; i++) {
        tokens.add(createViewerToken());
      }
      expect(tokens.size).toBe(50);
    });
  });
});
