export class OrganizationService {}

export class Logger {}

export class Repository {}

export class TenantController {
	private logger: Logger;

	constructor(private service: OrganizationService) {}

	resolve(repo: Repository): OrganizationService {
		return this.service;
	}

	load(): Array<Repository> {
		return [];
	}

	count(value: number): string {
		return String(value);
	}
}
