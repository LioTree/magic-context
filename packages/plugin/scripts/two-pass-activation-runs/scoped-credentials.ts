import type { ScopedCredentials } from "./activation-driver";

type CredentialId = Parameters<ScopedCredentials["getScoped"]>[0];

/** Caller supplies the credential-broker client and enrollment token in memory. */
export function scopedCredentials(input: {
    client: {
        getScoped(request: { credentialId: string; enrollmentToken: string }): Promise<{ material: string }>;
    };
    enrollmentToken: string;
    onRunEnded(id: CredentialId): Promise<void>;
}): ScopedCredentials {
    return {
        async getScoped(id) {
            if (!input.enrollmentToken || !["apikey:anthropic", "apikey:cline-pass"].includes(id))
                throw new Error("exact_credential_grant_required");
            const response = await input.client.getScoped({ credentialId: id, enrollmentToken: input.enrollmentToken });
            if (!response.material) throw new Error("empty_scoped_credential");
            return response.material;
        },
        notifyRunEnded: (id) => input.onRunEnded(id),
    };
}
