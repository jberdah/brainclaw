<?php
namespace App\Models;

class User implements Identifiable {
    const ROLE = 'user';
    public int $id;
    private string $name;

    public function __construct(int $id) {
        $this->id = $id;
    }

    public function getName(): string {
        return $this->name;
    }

    private static function make(): self {
        return new self(0);
    }
}
