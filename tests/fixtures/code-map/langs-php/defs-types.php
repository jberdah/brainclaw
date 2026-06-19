<?php
namespace App\Contracts;

interface Repo {
    public function find(int $id): ?object;
    public function all(): array;
}

trait Timestamps {
    public function touch(): void {}
}

enum Status: string {
    case Active = 'active';
    case Inactive = 'inactive';

    public function label(): string {
        return ucfirst($this->value);
    }
}

function make_repo(): Repo {
    return new InMemoryRepo();
}

const APP_VERSION = '1.0';
