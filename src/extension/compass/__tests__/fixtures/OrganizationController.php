<?php

namespace App\Http\Controllers;

use App\Services\Organization\OrganizationService;

class OrganizationController
{
    public function __construct(private OrganizationService $service)
    {
    }

    public function index(): string
    {
        return $this->service->resolveTenant();
    }
}
