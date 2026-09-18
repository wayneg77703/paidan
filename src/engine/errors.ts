// Shared structured failures; presentation belongs to the CLI.

export class PaidanError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly details?: unknown,
    ) {
        super(message)
    }
}
