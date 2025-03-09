# Nectar - Automatic Coupon Finder

## 🍯 What is Nectar?

Nectar is a powerful browser extension that automatically finds and tests coupon codes while you shop online. Stop wasting time searching for coupon codes - Nectar lets you apply them with a single click.

## ✨ Features

- **Automatic Coupon Detection**: Instantly identifies available coupon codes for the site you're browsing
- **Verified Coupons**: Shows which coupons have been verified to work recently
- **One-Click Apply**: Apply coupon codes directly to checkout forms with a single click
- **Success Rate Tracking**: See which codes have the highest success rate from other users
- **Clean, Minimalist UI**: Beautiful interface that doesn't get in your way
- **Regular Updates**: Coupon database is refreshed frequently to ensure you get the latest deals

## 📦 Installation

### Chrome Web Store

1. Visit the [Nectar page on the Chrome Web Store](https://chrome.google.com/webstore/detail/nectar/[extension-id])
2. Click "Add to Chrome"
3. Confirm the installation

### Firefox Add-ons

1. Visit the [Nectar page on Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/nectar-coupon-finder/)
2. Click "Add to Firefox"
3. Confirm the installation

### Manual Installation (Development)

See the [Development](#development) section below.

## 🚀 Usage

1. **Shop as usual**: Browse your favorite online stores
2. **Click the Nectar icon**: When you're ready to check out, click the Nectar icon in your browser toolbar
3. **Browse available coupons**: Nectar will display available coupon codes with their discounts
4. **Apply a coupon**: Either copy the code manually or click "Apply" to automatically fill in the coupon field
5. **Enjoy your savings!** 💰

## 💻 Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- [npm](https://www.npmjs.com/) (v7 or higher)
- [Git](https://git-scm.com/)

### Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/yourusername/nectar-extension.git
   cd nectar-extension
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Build the extension:

   ```bash
   pnpm run build
   ```

4. Load the extension in your browser:

   - Chrome:

     1. Go to `chrome://extensions/`
     2. Enable "Developer mode"
     3. Click "Load unpacked"
     4. Select the `dist` folder from the project directory

   - Firefox:
     1. Go to `about:debugging#/runtime/this-firefox`
     2. Click "Load Temporary Add-on..."
     3. Select the `manifest.json` file from the `dist` folder

### Project Structure

```
nectar-extension/
├── public/               # Static assets
├── src/
│   ├── components/       # React components
│   ├── lib/              # Utility functions
├── manifest-chrome.json  # Chrome Extension manifest
├── manifest-firefox.json # Firefox Extension manifest
├── package.json          # Project dependencies
└── README.md             # Project documentation
```

### Technologies Used

- [React](https://reactjs.org/) - UI framework
- [TypeScript](https://www.typescriptlang.org/) - Type safety
- [Tailwind CSS](https://tailwindcss.com/) - Styling
- [shadcn/ui](https://ui.shadcn.com/) - UI components
- [Chrome Extension API](https://developer.chrome.com/docs/extensions/reference/) - Browser integration

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
