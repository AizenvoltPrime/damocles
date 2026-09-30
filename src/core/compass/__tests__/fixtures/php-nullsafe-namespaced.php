<?php

namespace App\Service;

use App\Repository\UserRepository;

function bootstrap(): void
{
    \globalFn();

    $repo = getRepository();
    $repo?->lookup('user-1');
}

function getRepository(): ?UserRepository
{
    return new UserRepository();
}

function globalFn(): void
{
}
