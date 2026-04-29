import type { ContrailConfig } from '@atmo-dev/contrail';

// Replace `namespace` with your reverse-DNS domain (e.g. mybookmarks.app → app.mybookmarks).
// Add collections the app indexes — see https://flo-bit.dev/contrail/llms-full.txt
export const config: ContrailConfig = {
	namespace: 'app.example',
	collections: {}
};
