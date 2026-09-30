using System;
using Xunit;

namespace App.Checks
{
    public class TenantServiceChecks
    {
        [Fact]
        public void CreatesTenant()
        {
            HelperMethod();
        }

        [Theory]
        [InlineData(1)]
        public void HandlesManyInputs(int value)
        {
            HelperMethod();
        }

        [TestMethod]
        public void RunsUnderMsTest()
        {
            HelperMethod();
        }

        [Obsolete]
        public void HelperMethod()
        {
        }
    }
}
