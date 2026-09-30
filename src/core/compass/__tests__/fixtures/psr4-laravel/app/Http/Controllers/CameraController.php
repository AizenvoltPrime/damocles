<?php

namespace App\Http\Controllers;

use App\Models\Camera;
use App\Models\Camera as AliasedCamera;
use App\Services\Organization\OrganizationContext;
use Database\Seeders\Demo\DemoDataConstants;
use Illuminate\Console\Command;
use Google\Auth\Credentials\ServiceAccountCredentials;

class CameraController
{
    public function __construct(private OrganizationContext $context)
    {
    }

    public function show(Camera $camera): string
    {
        $projectName = DemoDataConstants::PROJECT_NAME;
        return $camera->describe() . ' ' . $projectName;
    }
}
