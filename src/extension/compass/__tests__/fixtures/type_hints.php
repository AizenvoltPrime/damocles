<?php

namespace App\Services;

class OrganizationService
{
}

class Logger
{
}

class Repository
{
}

class TenantController
{
    private Logger $logger;

    public function __construct(private OrganizationService $service)
    {
    }

    public function resolve(Repository $repo): OrganizationService
    {
        return $this->service;
    }

    public function count(int $value): string
    {
        return (string) $value;
    }
}
