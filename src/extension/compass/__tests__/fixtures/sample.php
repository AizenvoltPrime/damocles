<?php

namespace App\Http;

use App\Auth\Authenticator;
use App\Cache\CacheManager;

interface Cacheable
{
    public function getCacheKey(): string;
    public function getTtl(): int;
}

trait Loggable
{
    public function log(string $message): void
    {
        echo $message;
    }
}

class ApiClient implements Cacheable
{
    use Loggable;

    private string $baseUrl;
    private Authenticator $auth;

    public function __construct(string $baseUrl)
    {
        $this->baseUrl = $baseUrl;
        $this->auth = new Authenticator();
    }

    public function getCacheKey(): string
    {
        return md5($this->baseUrl);
    }

    public function getTtl(): int
    {
        return 3600;
    }

    public function get(string $path): string
    {
        $this->log("GET $path");
        return $this->fetch($path, 'GET');
    }

    public function post(string $path, string $body): string
    {
        return $this->fetch($path, 'POST');
    }

    private function fetch(string $path, string $method): string
    {
        $token = $this->auth->getToken();
        return $method . ' ' . $this->baseUrl . $path;
    }
}

function parseResponse(string $raw): array
{
    return json_decode($raw, true);
}
