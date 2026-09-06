import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ionic.starter',
  appName: 'Emaki',
  webDir: 'www',
  plugins: {
    CapacitorAssets: {
      iconBackgroundColor: '#4C5A60',
      iconBackgroundColorDark: '#39434A',
    },
  },
};

export default config;
