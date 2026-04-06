import { Response } from './models';

interface HttpOptions {
    timeout: number;
    retries: number;
    getHeaders(): Record<string, string>;
}

type RequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

enum StatusCode {
    OK = 200,
    NotFound = 404,
    ServerError = 500,
}

abstract class BaseClient {
    abstract connect(): void;
}

class HttpClient extends BaseClient {
    private baseUrl: string;

    constructor(baseUrl: string) {
        super();
        this.baseUrl = baseUrl;
    }

    connect(): void {}

    async get(path: string): Promise<Response> {
        return fetch(this.baseUrl + path);
    }

    async post(path: string, body: unknown): Promise<Response> {
        return this.get(path);
    }
}

function buildHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
}

export { HttpClient, buildHeaders };
